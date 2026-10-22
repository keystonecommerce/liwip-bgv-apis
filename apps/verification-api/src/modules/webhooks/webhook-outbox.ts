import type { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";

/** Events a partner's endpoint receives. */
export const WEBHOOK_EVENTS = ["case.status_changed", "case.completed", "webhook.test"] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export interface CaseChange {
  applicationId: string;
  tenantId: string;
  clientId: string;
  packageCode: string | null;
  relationshipStatus: string;
  before: { status: string; finalResult: string | null };
  after: { status: string; finalResult: string | null };
}

/** The body every endpoint receives: no personal data, only what changed and where to read more. */
export function eventBody(eventId: string, event: WebhookEvent, data: Record<string, unknown>, at = new Date()) {
  return { id: eventId, type: event, createdAt: at.toISOString(), data };
}

/**
 * Writes the deliveries for a case change in the same transaction as the change (an outbox), so
 * an event is never lost or sent for a change that rolled back. A partner hears about a case only
 * while the person's relationship with them is active.
 */
export async function recordCaseEvents(tx: Prisma.TransactionClient, change: CaseChange): Promise<void> {
  const statusChanged = change.before.status !== change.after.status;
  const completed = change.after.finalResult !== null && change.after.finalResult !== change.before.finalResult;
  if ((!statusChanged && !completed) || change.relationshipStatus !== "ACTIVE") return;
  const endpoints = await tx.webhookEndpoint.findMany({
    where: { tenantId: change.tenantId, status: "ACTIVE", OR: [{ clientId: null }, { clientId: change.clientId }] },
    select: { id: true }
  });
  if (!endpoints.length) return;
  const data = {
    caseId: change.applicationId, programId: change.clientId, packageCode: change.packageCode,
    status: change.after.status, previousStatus: change.before.status, finalResult: change.after.finalResult,
    report: `/v1/applications/${change.applicationId}/report`
  };
  const events: WebhookEvent[] = [...(statusChanged ? ["case.status_changed" as const] : []), ...(completed ? ["case.completed" as const] : [])];
  const now = new Date();
  await tx.webhookDelivery.createMany({
    data: events.flatMap((event) => {
      const eventId = `evt_${randomUUID()}`;
      return endpoints.map((endpoint) => ({
        id: `whd_${randomUUID()}`, endpointId: endpoint.id, tenantId: change.tenantId, eventId, event, applicationId: change.applicationId,
        payload: eventBody(eventId, event, data, now) as Prisma.InputJsonValue, nextAttemptAt: now
      }));
    })
  });
}
