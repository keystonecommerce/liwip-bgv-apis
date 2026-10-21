import { CallHandler, ExecutionContext, Inject, Injectable, NestInterceptor } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { Observable, tap } from "rxjs";
import { RequestWithClient } from "../auth/client-context";
import { ADMIN_AUDIT, AdminRequest, AuditRule } from "../../modules/admin-access/admin-context";
import { AuditOutcome, AuditService } from "./audit.service";

type HeaderRequest = RequestWithClient & AdminRequest & {
  method?: string;
  url?: string;
  originalUrl?: string;
  ip?: string;
  route?: { path?: string };
  headers: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string };
};

const firstHeader = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

const extractResourceId = (body: unknown): string | null => {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  if (typeof record.id === "string") return record.id;
  const nested = record.application as Record<string, unknown> | undefined;
  if (nested && typeof nested.id === "string") return nested.id;
  return null;
};

/**
 * Records one AuditLog row per PARTNER API call (requests that carry a
 * clientContext set by ApiKeyGuard) and per admin panel call (requests that
 * carry request.admin set by AdminAccessGuard). Other requests are skipped.
 * Runs after guards, so auth is already resolved; handler errors are captured
 * too. Rejected auth is logged by ApiKeyGuard and AdminAccessGuard.
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(@Inject(AuditService) private readonly audit: AuditService, @Inject(Reflector) private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<HeaderRequest>();
    if (request.admin) return this.interceptAdmin(context, request, next);
    const client = request.clientContext;
    if (!client) return next.handle(); // not a partner request — don't audit

    const start = Date.now();
    const method = request.method ?? "";
    const path = request.route?.path ?? "";
    const ip = request.ip ?? request.socket?.remoteAddress ?? null;
    const userAgent = firstHeader(request.headers["user-agent"]) ?? null;

    const base = {
      actorType: "PARTNER" as const,
      action: `${method} ${path}`.trim(),
      tenantId: client.tenantId,
      tenantSlug: client.tenantSlug,
      clientId: client.clientId,
      clientCode: client.clientCode,
      apiKeyId: client.apiKeyId,
      scopeUsed: client.scopes?.join(" ") ?? null,
      method,
      path,
      ip,
      userAgent,
    };

    return next.handle().pipe(
      tap({
        next: (body) => {
          const response = context.switchToHttp().getResponse<{ statusCode?: number }>();
          this.audit.record({
            ...base,
            outcome: "SUCCESS",
            statusCode: response?.statusCode ?? 200,
            resourceId: extractResourceId(body),
            durationMs: Date.now() - start,
          });
        },
        error: (error: unknown) => {
          const status = (error as { status?: number })?.status ?? 500;
          const outcome: AuditOutcome = status >= 500 ? "SERVER_ERROR" : "CLIENT_ERROR";
          const message = `Request failed with status ${status}`;
          this.audit.record({
            ...base,
            outcome,
            statusCode: status,
            durationMs: Date.now() - start,
            message,
          });
        },
      })
    );
  }

  /** One row per admin panel request: who, at which scope, on what, and how it ended. */
  private interceptAdmin(context: ExecutionContext, request: HeaderRequest, next: CallHandler): Observable<unknown> {
    const rule = this.reflector.getAllAndOverride<AuditRule | undefined>(ADMIN_AUDIT, [context.getHandler(), context.getClass()]);
    if (rule?.skip) return next.handle();
    const admin = request.admin!;
    const start = Date.now();
    const method = request.method ?? "";
    const path = request.route?.path ?? "";
    const write = (outcome: AuditOutcome, statusCode: number, body?: unknown, message?: string) => {
      const note = admin.audit;
      const scopeTenant = admin.scope.kind === "PARTNER" ? admin.scope.tenantId : null;
      this.audit.record({
        actorType: "STAFF",
        actorUserId: admin.user.id,
        action: rule?.action || `${method} ${path}`.trim(),
        outcome,
        statusCode,
        tenantId: note.tenantId !== undefined ? note.tenantId : scopeTenant,
        tenantSlug: admin.scope.kind === "PARTNER" && (note.tenantId === undefined || note.tenantId === scopeTenant) ? admin.scope.tenantSlug : null,
        clientId: note.clientId ?? null,
        resourceType: note.resourceType ?? rule?.resourceType ?? null,
        resourceId: note.resourceId ?? (rule?.resourceParam ? request.params?.[rule.resourceParam] : undefined) ?? extractResourceId(body),
        scopeUsed: admin.scope.kind,
        method,
        path,
        ip: request.ip ?? request.socket?.remoteAddress ?? null,
        userAgent: firstHeader(request.headers["user-agent"]) ?? null,
        durationMs: Date.now() - start,
        message: message ?? null,
        metadata: note.metadata ?? null,
      });
    };
    return next.handle().pipe(
      tap({
        next: (body) => write("SUCCESS", context.switchToHttp().getResponse<{ statusCode?: number }>()?.statusCode ?? 200, body),
        error: (error: unknown) => {
          const status = (error as { status?: number })?.status ?? 500;
          write(status >= 500 ? "SERVER_ERROR" : "CLIENT_ERROR", status, undefined, `Request failed with status ${status}`);
        },
      })
    );
  }
}
