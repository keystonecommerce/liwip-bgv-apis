import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { createHash } from "node:crypto";
import { PrismaService } from "../database/prisma.service";
import { RequestWithClient } from "./client-context";

type HeaderRequest = RequestWithClient & { headers: Record<string, string | string[] | undefined> };

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<HeaderRequest>();
    const value = request.headers["x-api-key"];
    const rawKey = Array.isArray(value) ? value[0] : value;
    if (!rawKey) throw new UnauthorizedException("X-API-Key header is required");

    const keyHash = createHash("sha256").update(rawKey).digest("hex");
    const apiKey = await this.prisma.apiKey.findUnique({
      where: { keyHash },
      include: { client: { include: { tenant: true } } }
    });
    const expired = apiKey?.expiresAt && apiKey.expiresAt.getTime() <= Date.now();
    if (!apiKey || !apiKey.isActive || expired || apiKey.client.status !== "ACTIVE" || apiKey.client.tenant.status !== "ACTIVE") {
      throw new UnauthorizedException("API key is invalid, expired or inactive");
    }

    request.clientContext = {
      tenantId: apiKey.client.tenantId,
      tenantSlug: apiKey.client.tenant.slug,
      clientId: apiKey.clientId,
      clientCode: apiKey.client.code,
      apiKeyId: apiKey.id,
      scopes: Array.isArray(apiKey.scopes) ? apiKey.scopes.map(String) : []
    };
    void this.prisma.apiKey.update({ where: { id: apiKey.id }, data: { lastUsedAt: new Date() } });
    return true;
  }
}
