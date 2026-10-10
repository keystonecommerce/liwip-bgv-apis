import { Inject, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { UnrecoverableError } from "bullmq";
import { PrismaService } from "../../common/database/prisma.service";
import { providerCallContext } from "./provider-call.context";

export function classifyProviderResponse(status: number, body: unknown): "SUCCESS" | "REJECTED" | "UNKNOWN" {
  const envelope = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : null;
  if (status >= 200 && status < 300 && envelope?.success === true && envelope.data !== null && typeof envelope.data === "object") return "SUCCESS";
  // Explicit provider rejections are known failures; malformed 2xx and server errors
  // are ambiguous and must not be treated as evidence that no paid work occurred.
  if (status >= 400 && status < 500 || status >= 200 && status < 300 && envelope?.success === false) return "REJECTED";
  return "UNKNOWN";
}
export function uncertainCall(message: string): UnrecoverableError & { code: string } {
  const error = new UnrecoverableError(message) as UnrecoverableError & { code: string };
  error.code = "PROVIDER_OUTCOME_UNKNOWN";
  return error;
}

@Injectable()
export class ProviderCallService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}
  /** The provider adapter owns HTTP details; the ledger owns durable evidence. */
  async dispatch(provider: string, operation: string, send: () => Promise<Response>): Promise<Response> {
    const context = providerCallContext.getStore();
    if (!context) {
      if (process.env.NODE_ENV === "production") throw new ServiceUnavailableException("Provider call ownership is required");
      return send(); // explicitly local provider-test routes only
    }
    const operationKey = `${context.operationKey}:${provider}:${operation}`;
    // No fetch can occur until ownership and the STARTED row commit. A duplicate
    // operation is deliberately blocked, including a crashed process's STARTED row.
    const row = await this.prisma.$transaction(async tx => {
      const client = await tx.client.findFirst({ where: { id: context.clientId, tenantId: context.tenantId, status: "ACTIVE", tenant: { status: "ACTIVE" } }, select: { id: true } });
      if (!client) throw new ServiceUnavailableException("Provider call owner is inactive");
      if (context.verificationId) {
        const verification = await tx.verification.findFirst({ where: { id: context.verificationId, applicationId: context.applicationId, application: { tenantId: context.tenantId, clientId: context.clientId } }, select: { id: true } });
        if (!verification) throw new ServiceUnavailableException("Verification ownership mismatch");
      }
      const existing = await tx.providerCall.findUnique({ where: { operationKey }, select: { id: true } });
      if (existing) throw uncertainCall("Provider operation already dispatched; reconcile before retrying");
      return tx.providerCall.create({ data: { id: `pcall_${randomUUID()}`, ...context, operationKey, provider, operation, state: "STARTED" } });
    }).catch(error => {
      if (error?.code === "P2002") throw uncertainCall("Concurrent provider operation already dispatched");
      throw error;
    });
    let response: Response;
    let body: unknown;
    try {
      response = await send();
      body = await response.clone().json();
    } catch {
      await this.finish(row.id, "UNKNOWN");
      throw uncertainCall("Provider outcome could not be confirmed; reconcile before retrying");
    }
    const state = classifyProviderResponse(response.status, body);
    const data = (body as { data?: Record<string, unknown> })?.data;
    await this.finish(row.id, state, response.status, typeof data?.client_id === "string" ? data.client_id.slice(0, 200) : undefined);
    if (state === "UNKNOWN") throw uncertainCall("Provider returned an inconclusive response; reconcile before retrying");
    return response;
  }
  private async finish(id: string, state: string, httpStatus?: number, providerRequestId?: string) {
    try {
      await this.prisma.providerCall.update({ where: { id, state: "STARTED" }, data: { state, httpStatus, providerRequestId, completedAt: new Date() } });
    } catch {
      // STARTED remains visible for reconciliation. Never replay a successful paid
      // operation because its durable response write was unavailable.
      throw uncertainCall("Provider accounting finalization failed; reconcile before retrying");
    }
  }
}
