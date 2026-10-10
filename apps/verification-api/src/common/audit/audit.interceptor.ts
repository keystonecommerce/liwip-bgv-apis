import { CallHandler, ExecutionContext, Inject, Injectable, NestInterceptor } from "@nestjs/common";
import { Observable, tap } from "rxjs";
import { RequestWithClient } from "../auth/client-context";
import { AuditOutcome, AuditService } from "./audit.service";

type HeaderRequest = RequestWithClient & {
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
 * clientContext set by ApiKeyGuard). Portal/internal/health requests are
 * skipped. Runs after guards, so auth is already resolved; handler errors are
 * captured too. Rejected auth is logged separately by ApiKeyGuard.
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(@Inject(AuditService) private readonly audit: AuditService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<HeaderRequest>();
    const client = request.clientContext;
    if (!client) return next.handle(); // not a partner request — don't audit

    const start = Date.now();
    const method = request.method ?? "";
    const path = request.route?.path ?? request.originalUrl ?? request.url ?? "";
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
          const message = error instanceof Error ? error.message : String(error);
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
}
