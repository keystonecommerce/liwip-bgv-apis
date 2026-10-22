import { PartnerRateLimitService } from "../security/partner-rate-limit.service";
import { CanActivate, ExecutionContext, Inject, Injectable, Logger, UnauthorizedException } from "@nestjs/common";
import { createHash } from "node:crypto";
import { PrismaService } from "../database/prisma.service";
import { AuditService } from "../audit/audit.service";
import { RequestWithClient } from "./client-context";

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

@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly logger = new Logger(ApiKeyGuard.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(PartnerRateLimitService) private readonly quota: PartnerRateLimitService
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<HeaderRequest>();
    const value = request.headers["x-api-key"];
    const rawKey = Array.isArray(value) ? value[0] : value;

    const reject = (reason: string, keyPrefix?: string): never => {
      this.audit.record({
        actorType: "SYSTEM",
        action: "auth.rejected",
        outcome: "REJECTED",
        method: request.method ?? null,
        path: request.route?.path ?? null,
        keyPrefix: keyPrefix ?? null,
        ip: request.ip ?? request.socket?.remoteAddress ?? null,
        userAgent: firstHeader(request.headers["user-agent"]) ?? null,
        message: reason,
      });
      throw new UnauthorizedException(reason);
    };

    if (typeof value !== "string" || !rawKey || rawKey.length > 128) reject("X-API-Key header is required");

    const keyHash = createHash("sha256").update(rawKey as string).digest("hex");
    const apiKey = await this.prisma.apiKey.findUnique({
      where: { keyHash },
      include: { client: { include: { tenant: true } } },
    });
    const prefix = (rawKey as string).slice(0, 10);
    const expired = apiKey?.expiresAt && apiKey.expiresAt.getTime() <= Date.now();
    if (!apiKey || !apiKey.isActive || apiKey.revokedAt || expired || apiKey.client.status !== "ACTIVE" || apiKey.client.tenant.status !== "ACTIVE") {
      reject("API key is invalid, expired or inactive", prefix);
    }

    request.clientContext = {
      tenantId: apiKey!.client.tenantId,
      tenantSlug: apiKey!.client.tenant.slug,
      clientId: apiKey!.clientId,
      clientCode: apiKey!.client.code,
      apiKeyId: apiKey!.id,
      scopes: Array.isArray(apiKey!.scopes) ? apiKey!.scopes.map(String) : [],
    };
    // The worker app's key carries every person's traffic; each person has their own limits (RateLimitService).
    if (!request.clientContext.scopes.includes("worker:cases")) await this.quota.check(apiKey!.clientId);
    // At most one write every 5 minutes: one shared key would otherwise rewrite the same row on every request.
    if (!apiKey!.lastUsedAt || Date.now() - apiKey!.lastUsedAt.getTime() > 5 * 60_000) {
      void this.prisma.apiKey
        .update({ where: { id: apiKey!.id }, data: { lastUsedAt: new Date() } })
        .catch((error: unknown) => this.logger.warn(`lastUsedAt update failed: ${error instanceof Error ? error.message : String(error)}`));
    }
    return true;
  }
}

