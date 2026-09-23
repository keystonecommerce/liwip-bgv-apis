import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { AuditService } from "../../common/audit/audit.service";
import { PrismaService } from "../../common/database/prisma.service";
import { generateApiKey, normalizeScopes } from "../../common/security/api-key.util";

export interface CreatePartnerInput {
  tenantSlug: string;
  tenantName: string;
  clientCode: string;
  clientName: string;
  keyName?: string;
  scopes?: string[];
  expiresInDays?: number;
}

export interface IssueKeyInput {
  keyName?: string;
  scopes?: string[];
  expiresInDays?: number;
}

const expiryFromDays = (days?: number): Date | null => {
  if (days == null) return null;
  if (!Number.isFinite(days) || days <= 0) throw new BadRequestException("expiresInDays must be a positive number");
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
};

// The raw key is returned only here, once; callers must hand it over securely.
const publicKey = (key: { id: string; keyPrefix: string; name: string; scopes: unknown; isActive: boolean; expiresAt: Date | null; createdAt: Date }) => ({
  id: key.id,
  name: key.name,
  keyPrefix: key.keyPrefix,
  scopes: Array.isArray(key.scopes) ? key.scopes.map(String) : [],
  isActive: key.isActive,
  expiresAt: key.expiresAt,
  createdAt: key.createdAt,
});

@Injectable()
export class AdminService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService
  ) {}

  async createPartner(input: CreatePartnerInput) {
    const tenantSlug = input.tenantSlug?.trim().toLowerCase();
    const clientCode = input.clientCode?.trim().toUpperCase();
    if (!tenantSlug || !input.tenantName?.trim() || !clientCode || !input.clientName?.trim()) {
      throw new BadRequestException("tenantSlug, tenantName, clientCode and clientName are required");
    }
    const scopes = normalizeScopesOrThrow(input.scopes);
    const expiresAt = expiryFromDays(input.expiresInDays);

    const tenant = await this.prisma.tenant.upsert({
      where: { slug: tenantSlug },
      update: { name: input.tenantName.trim(), status: "ACTIVE" },
      create: { id: `tenant_${randomUUID()}`, slug: tenantSlug, name: input.tenantName.trim(), status: "ACTIVE" },
    });
    const client = await this.prisma.client.upsert({
      where: { tenantId_code: { tenantId: tenant.id, code: clientCode } },
      update: { name: input.clientName.trim(), status: "ACTIVE" },
      create: { id: `client_${randomUUID()}`, tenantId: tenant.id, code: clientCode, name: input.clientName.trim(), status: "ACTIVE" },
    });

    const { raw, keyHash, keyPrefix } = generateApiKey();
    const apiKey = await this.prisma.apiKey.create({
      data: {
        id: `api_key_${randomUUID()}`,
        clientId: client.id,
        name: input.keyName?.trim() || "Platform API key",
        keyPrefix,
        keyHash,
        scopes,
        expiresAt,
      },
    });

    this.audit.record({
      actorType: "ADMIN",
      action: "partner.create",
      outcome: "SUCCESS",
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
      clientId: client.id,
      clientCode: client.code,
      apiKeyId: apiKey.id,
      keyPrefix,
      resourceType: "ApiKey",
      resourceId: apiKey.id,
      message: `Provisioned partner ${tenant.slug}/${client.code} with scopes: ${scopes.join(", ")}`,
    });

    return { tenant, client, apiKey: publicKey(apiKey), rawKey: raw };
  }

  async issueKey(clientId: string, input: IssueKeyInput) {
    const client = await this.prisma.client.findUnique({ where: { id: clientId }, include: { tenant: true } });
    if (!client) throw new NotFoundException("Client not found");
    const scopes = normalizeScopesOrThrow(input.scopes);
    const expiresAt = expiryFromDays(input.expiresInDays);

    const { raw, keyHash, keyPrefix } = generateApiKey();
    const apiKey = await this.prisma.apiKey.create({
      data: {
        id: `api_key_${randomUUID()}`,
        clientId: client.id,
        name: input.keyName?.trim() || "Platform API key",
        keyPrefix,
        keyHash,
        scopes,
        expiresAt,
      },
    });

    this.audit.record({
      actorType: "ADMIN",
      action: "apiKey.issue",
      outcome: "SUCCESS",
      tenantId: client.tenantId,
      tenantSlug: client.tenant.slug,
      clientId: client.id,
      clientCode: client.code,
      apiKeyId: apiKey.id,
      keyPrefix,
      resourceType: "ApiKey",
      resourceId: apiKey.id,
    });

    return { apiKey: publicKey(apiKey), rawKey: raw };
  }

  async revokeKey(apiKeyId: string) {
    const existing = await this.prisma.apiKey.findUnique({ where: { id: apiKeyId }, include: { client: { include: { tenant: true } } } });
    if (!existing) throw new NotFoundException("API key not found");
    const apiKey = await this.prisma.apiKey.update({
      where: { id: apiKeyId },
      data: { isActive: false, revokedAt: new Date() },
    });
    this.audit.record({
      actorType: "ADMIN",
      action: "apiKey.revoke",
      outcome: "SUCCESS",
      tenantId: existing.client.tenantId,
      tenantSlug: existing.client.tenant.slug,
      clientId: existing.clientId,
      clientCode: existing.client.code,
      apiKeyId: existing.id,
      keyPrefix: existing.keyPrefix,
      resourceType: "ApiKey",
      resourceId: existing.id,
    });
    return { apiKey: publicKey(apiKey) };
  }

  /** Issue a fresh key inheriting the old key's scopes, then revoke the old one. */
  async rotateKey(apiKeyId: string) {
    const existing = await this.prisma.apiKey.findUnique({ where: { id: apiKeyId }, include: { client: { include: { tenant: true } } } });
    if (!existing) throw new NotFoundException("API key not found");

    const { raw, keyHash, keyPrefix } = generateApiKey();
    const created = await this.prisma.apiKey.create({
      data: {
        id: `api_key_${randomUUID()}`,
        clientId: existing.clientId,
        name: existing.name,
        keyPrefix,
        keyHash,
        scopes: existing.scopes as string[],
        expiresAt: existing.expiresAt,
      },
    });
    await this.prisma.apiKey.update({ where: { id: existing.id }, data: { isActive: false, revokedAt: new Date() } });

    this.audit.record({
      actorType: "ADMIN",
      action: "apiKey.rotate",
      outcome: "SUCCESS",
      tenantId: existing.client.tenantId,
      tenantSlug: existing.client.tenant.slug,
      clientId: existing.clientId,
      clientCode: existing.client.code,
      apiKeyId: created.id,
      keyPrefix,
      resourceType: "ApiKey",
      resourceId: created.id,
      message: `Rotated from ${existing.keyPrefix} (revoked)`,
    });

    return { apiKey: publicKey(created), rawKey: raw, revokedKeyId: existing.id };
  }

  async listPartners() {
    const tenants = await this.prisma.tenant.findMany({
      orderBy: { createdAt: "desc" },
      include: {
        clients: {
          include: {
            apiKeys: {
              orderBy: { createdAt: "desc" },
              select: { id: true, name: true, keyPrefix: true, scopes: true, isActive: true, expiresAt: true, lastUsedAt: true, revokedAt: true, createdAt: true },
            },
          },
        },
      },
    });
    return { tenants };
  }
}

function normalizeScopesOrThrow(scopes?: string[]): string[] {
  try {
    return normalizeScopes(scopes);
  } catch (error) {
    throw new BadRequestException(error instanceof Error ? error.message : "Invalid scopes");
  }
}
