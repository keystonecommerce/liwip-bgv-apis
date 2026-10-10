import { Inject, Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../database/prisma.service";

export type AuditActor = "PARTNER" | "ADMIN" | "SYSTEM";
export type AuditOutcome = "SUCCESS" | "CLIENT_ERROR" | "SERVER_ERROR" | "REJECTED";

export interface AuditEntry {
  actorType: AuditActor;
  action: string;
  outcome: AuditOutcome;
  tenantId?: string | null;
  tenantSlug?: string | null;
  clientId?: string | null;
  clientCode?: string | null;
  apiKeyId?: string | null;
  keyPrefix?: string | null;
  method?: string | null;
  path?: string | null;
  statusCode?: number | null;
  resourceType?: string | null;
  resourceId?: string | null;
  scopeUsed?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  durationMs?: number | null;
  message?: string | null;
}

export interface AuditQuery {
  tenantId?: string;
  clientId?: string;
  apiKeyId?: string;
  action?: string;
  outcome?: AuditOutcome;
  limit?: number;
  before?: Date;
}

const cap = (value: string | null | undefined, max: number): string | null => {
  if (value == null) return null;
  return value.length > max ? value.slice(0, max) : value;
};

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * Persist one audit row. Fire-and-forget by design: auditing must never
   * throw into or slow down the request path, so failures are only logged.
   */
  record(entry: AuditEntry): void {
    void this.prisma.auditLog
      .create({
        data: {
          id: `audit_${randomUUID()}`,
          actorType: entry.actorType,
          action: cap(entry.action, 120) ?? "unknown",
          outcome: entry.outcome,
          tenantId: entry.tenantId ?? null,
          tenantSlug: entry.tenantSlug ?? null,
          clientId: entry.clientId ?? null,
          clientCode: entry.clientCode ?? null,
          apiKeyId: entry.apiKeyId ?? null,
          keyPrefix: entry.keyPrefix ?? null,
          method: entry.method ?? null,
          path: cap(entry.path, 500),
          statusCode: entry.statusCode ?? null,
          resourceType: entry.resourceType ?? null,
          resourceId: cap(entry.resourceId, 120),
          scopeUsed: cap(entry.scopeUsed, 200),
          ip: cap(entry.ip, 64),
          userAgent: cap(entry.userAgent, 300),
          durationMs: entry.durationMs ?? null,
          message: cap(entry.message, 1000),
        },
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`Audit write failed (${entry.action}): ${message}`);
      });
  }

  /** Read recent audit rows, newest first. Callers scope by tenant/client. */
  async list(query: AuditQuery) {
    const requested = Number(query.limit);
    const limit = Number.isFinite(requested) ? Math.min(Math.max(Math.trunc(requested), 1), 200) : 50;
    return this.prisma.auditLog.findMany({
      where: {
        tenantId: query.tenantId,
        clientId: query.clientId,
        apiKeyId: query.apiKeyId,
        action: query.action,
        outcome: query.outcome,
        ...(query.before ? { createdAt: { lt: query.before } } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
  }
}
