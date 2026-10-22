import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { Prisma, WebhookEndpoint } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../../common/database/prisma.service";
import { AdminContext, scopedTenantId } from "../admin-access/admin-context";
import { id, optionalText } from "../admin-panel/input";
import { eventBody } from "./webhook-outbox";
import { encryptSecret, newWebhookSecret } from "./webhook-secrets";
import { webhookUrl } from "./webhook-url";

export interface EndpointInput { url?: unknown; programId?: unknown; description?: unknown }

const MAX_ENDPOINTS = 10;

/**
 * A partner's webhook endpoints. Keystone manages any partner's (x-partner-id, or the program's
 * partner); a partner admin manages their own. The signing secret is returned once, on create
 * and on rotate.
 */
@Injectable()
export class WebhooksService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async list(admin: AdminContext) {
    const tenantId = scopedTenantId(admin);
    const endpoints = await this.prisma.webhookEndpoint.findMany({ where: tenantId ? { tenantId } : {}, orderBy: { createdAt: "desc" }, take: 200 });
    const failing = await this.prisma.webhookDelivery.groupBy({ by: ["endpointId", "status"], where: { endpointId: { in: endpoints.map((endpoint) => endpoint.id) }, status: { in: ["PENDING", "FAILED"] } }, _count: true });
    return {
      items: endpoints.map((endpoint) => ({
        ...this.view(endpoint),
        waiting: failing.find((row) => row.endpointId === endpoint.id && row.status === "PENDING")?._count ?? 0,
        failed: failing.find((row) => row.endpointId === endpoint.id && row.status === "FAILED")?._count ?? 0
      }))
    };
  }

  async create(admin: AdminContext, input: EndpointInput) {
    const url = webhookUrl(input?.url);
    const programId = input?.programId ? id(input.programId, "programId") : null;
    let tenantId = scopedTenantId(admin);
    if (programId) {
      const program = await this.prisma.client.findFirst({ where: { id: programId, ...(tenantId ? { tenantId } : {}) }, select: { tenantId: true } });
      if (!program) throw new NotFoundException("Program not found");
      tenantId = program.tenantId;
    }
    if (!tenantId) throw new BadRequestException("Choose the partner (x-partner-id) or a program");
    if ((await this.prisma.webhookEndpoint.count({ where: { tenantId, status: "ACTIVE" } })) >= MAX_ENDPOINTS) throw new ConflictException(`A partner can have up to ${MAX_ENDPOINTS} active endpoints`);
    const secret = newWebhookSecret();
    const endpoint = await this.prisma.webhookEndpoint.create({
      data: { id: `whe_${randomUUID()}`, tenantId, clientId: programId, url, description: optionalText(input?.description, "description", 200) ?? null, secretCiphertext: encryptSecret(secret), createdById: admin.user.id }
    });
    admin.audit = { tenantId, resourceType: "WebhookEndpoint", resourceId: endpoint.id, metadata: { url, programId } };
    return { endpoint: this.view(endpoint), secret };
  }

  async rotate(admin: AdminContext, endpointId: string) {
    const endpoint = await this.endpoint(admin, endpointId);
    const secret = newWebhookSecret();
    const updated = await this.prisma.webhookEndpoint.update({ where: { id: endpoint.id }, data: { secretCiphertext: encryptSecret(secret) } });
    admin.audit = { tenantId: endpoint.tenantId, resourceType: "WebhookEndpoint", resourceId: endpoint.id };
    return { endpoint: this.view(updated), secret };
  }

  async setStatus(admin: AdminContext, endpointId: string, status: "ACTIVE" | "DISABLED") {
    const endpoint = await this.endpoint(admin, endpointId);
    const updated = await this.prisma.webhookEndpoint.update({ where: { id: endpoint.id }, data: { status } });
    admin.audit = { tenantId: endpoint.tenantId, resourceType: "WebhookEndpoint", resourceId: endpoint.id, metadata: { status } };
    return this.view(updated);
  }

  /** Queues a `webhook.test` event for this endpoint now. */
  async test(admin: AdminContext, endpointId: string) {
    const endpoint = await this.endpoint(admin, endpointId);
    if (endpoint.status !== "ACTIVE") throw new ConflictException("Enable the endpoint first");
    const eventId = `evt_${randomUUID()}`;
    const delivery = await this.prisma.webhookDelivery.create({
      data: { id: `whd_${randomUUID()}`, endpointId: endpoint.id, tenantId: endpoint.tenantId, eventId, event: "webhook.test", payload: eventBody(eventId, "webhook.test", { endpointId: endpoint.id }) as Prisma.InputJsonValue }
    });
    admin.audit = { tenantId: endpoint.tenantId, resourceType: "WebhookEndpoint", resourceId: endpoint.id };
    return this.deliveryView(delivery);
  }

  async deliveries(admin: AdminContext, endpointId: string) {
    const endpoint = await this.endpoint(admin, endpointId);
    const rows = await this.prisma.webhookDelivery.findMany({ where: { endpointId: endpoint.id }, orderBy: { createdAt: "desc" }, take: 100 });
    return { items: rows.map((row) => this.deliveryView(row)) };
  }

  /** Sends a delivery again as soon as possible: a failed one gets a fresh set of attempts. */
  async retry(admin: AdminContext, deliveryId: string) {
    const tenantId = scopedTenantId(admin);
    const delivery = await this.prisma.webhookDelivery.findFirst({ where: { id: deliveryId, ...(tenantId ? { tenantId } : {}) } });
    if (!delivery) throw new NotFoundException("Delivery not found");
    if (delivery.status === "DELIVERED" || delivery.status === "DELIVERING") throw new ConflictException("This delivery was already sent or is being sent");
    const updated = await this.prisma.webhookDelivery.update({ where: { id: delivery.id }, data: { status: "PENDING", nextAttemptAt: new Date(), ...(delivery.status === "FAILED" ? { attempts: 0 } : {}) } });
    admin.audit = { tenantId: delivery.tenantId, resourceType: "WebhookDelivery", resourceId: delivery.id };
    return this.deliveryView(updated);
  }

  private async endpoint(admin: AdminContext, endpointId: string): Promise<WebhookEndpoint> {
    const tenantId = scopedTenantId(admin);
    const endpoint = await this.prisma.webhookEndpoint.findFirst({ where: { id: endpointId, ...(tenantId ? { tenantId } : {}) } });
    if (!endpoint) throw new NotFoundException("Endpoint not found");
    return endpoint;
  }

  private view(endpoint: WebhookEndpoint) {
    return { id: endpoint.id, partnerId: endpoint.tenantId, programId: endpoint.clientId, url: endpoint.url, description: endpoint.description, status: endpoint.status, createdAt: endpoint.createdAt.toISOString(), updatedAt: endpoint.updatedAt.toISOString() };
  }

  private deliveryView(row: Prisma.WebhookDeliveryGetPayload<object>) {
    return {
      id: row.id, eventId: row.eventId, event: row.event, caseId: row.applicationId, status: row.status, attempts: row.attempts,
      nextAttemptAt: row.status === "PENDING" ? row.nextAttemptAt.toISOString() : null, lastStatusCode: row.lastStatusCode, lastError: row.lastError,
      deliveredAt: row.deliveredAt?.toISOString() ?? null, createdAt: row.createdAt.toISOString()
    };
  }
}
