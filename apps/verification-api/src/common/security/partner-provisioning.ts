import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { Prisma, PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { generateApiKey, normalizeScopes } from "./api-key.util";

export interface IssueKeyInput { keyName?: string; scopes?: string[]; expiresInDays?: number }
export interface CreatePartnerInput extends IssueKeyInput {
  tenantSlug: string; tenantName: string; clientCode: string; clientName: string;
}
export const publicKey = (key: { id: string; name: string; keyPrefix: string; scopes: unknown; isActive: boolean; expiresAt: Date | null; createdAt: Date }) => ({
  id: key.id, name: key.name, keyPrefix: key.keyPrefix, scopes: Array.isArray(key.scopes) ? key.scopes as string[] : [],
  isActive: key.isActive, expiresAt: key.expiresAt, createdAt: key.createdAt,
});
const text = (value: unknown, label: string, max = 120): string => {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) throw new BadRequestException(`${label} must contain 1 to ${max} characters`);
  return value.trim();
};
function options(input: IssueKeyInput) {
  let scopes: string[];
  try { scopes = normalizeScopes(input.scopes); } catch { throw new BadRequestException("Invalid scopes"); }
  const days = input.expiresInDays;
  if (days !== undefined && (!Number.isInteger(days) || days < 1 || days > 3650)) throw new BadRequestException("expiresInDays must be an integer from 1 to 3650");
  return { scopes, name: input.keyName === undefined ? "Platform API key" : text(input.keyName, "keyName"), expiresAt: days === undefined ? null : new Date(Date.now() + days * 86400000) };
}
const activeClient = (client: { status: string; tenant: { status: string } }) => {
  if (client.status !== "ACTIVE" || client.tenant.status !== "ACTIVE") throw new ForbiddenException("Partner is inactive");
};
function audit(tx: Prisma.TransactionClient, action: string, client: { id: string; code: string; tenantId: string; tenant: { slug: string } }, key: { id: string; keyPrefix: string }) {
  return tx.auditLog.create({ data: { id: `audit_${randomUUID()}`, actorType: "ADMIN", action, outcome: "SUCCESS", tenantId: client.tenantId, tenantSlug: client.tenant.slug, clientId: client.id, clientCode: client.code, apiKeyId: key.id, keyPrefix: key.keyPrefix, resourceType: "ApiKey", resourceId: key.id } });
}
async function createKey(tx: Prisma.TransactionClient, clientId: string, input: ReturnType<typeof options>) {
  const { raw, keyHash, keyPrefix } = generateApiKey();
  const key = await tx.apiKey.create({ data: { id: `api_key_${randomUUID()}`, clientId, keyHash, keyPrefix, ...input } });
  return { key, raw };
}
/** Shared by HTTP admin and CLI. No credential mutation commits without its audit row. */
export class PartnerProvisioning {
  constructor(private readonly prisma: PrismaClient) {}
  async createPartner(input: CreatePartnerInput) {
    const tenantSlug = text(input.tenantSlug, "tenantSlug", 80).toLowerCase();
    const clientCode = text(input.clientCode, "clientCode", 80).toUpperCase();
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(tenantSlug) || !/^[A-Z0-9][A-Z0-9_-]*$/.test(clientCode)) throw new BadRequestException("Invalid tenantSlug or clientCode");
    const tenantName = text(input.tenantName, "tenantName");
    const clientName = text(input.clientName, "clientName");
    const keyOptions = options(input);
    return this.prisma.$transaction(async tx => {
      const tenant = await tx.tenant.upsert({ where: { slug: tenantSlug }, update: {}, create: { id: `tenant_${randomUUID()}`, slug: tenantSlug, name: tenantName } });
      if (tenant.status !== "ACTIVE") throw new ForbiddenException("Tenant is inactive");
      const client = await tx.client.upsert({ where: { tenantId_code: { tenantId: tenant.id, code: clientCode } }, update: {}, create: { id: `client_${randomUUID()}`, tenantId: tenant.id, code: clientCode, name: clientName }, include: { tenant: true } });
      activeClient(client);
      const { key, raw } = await createKey(tx, client.id, keyOptions);
      await audit(tx, "partner.create", client, key);
      const { tenant: _, ...publicClient } = client;
      return { tenant, client: publicClient, apiKey: publicKey(key), rawKey: raw };
    });
  }
  async issueKey(clientId: string, input: IssueKeyInput) {
    const keyOptions = options(input);
    return this.prisma.$transaction(async tx => {
      const client = await tx.client.findUnique({ where: { id: clientId }, include: { tenant: true } });
      if (!client) throw new NotFoundException("Client not found");
      activeClient(client);
      const { key, raw } = await createKey(tx, client.id, keyOptions);
      await audit(tx, "apiKey.issue", client, key);
      return { apiKey: publicKey(key), rawKey: raw };
    });
  }
  async rotateKey(id: string) {
    return this.prisma.$transaction(async tx => {
      const existing = await tx.apiKey.findUnique({ where: { id }, include: { client: { include: { tenant: true } } } });
      if (!existing) throw new NotFoundException("API key not found");
      activeClient(existing.client);
      const now = new Date();
      const revoked = await tx.apiKey.updateMany({ where: { id, clientId: existing.clientId, isActive: true, revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }, data: { isActive: false, revokedAt: now } });
      if (revoked.count !== 1) throw new ConflictException("Only an active, unexpired key can be rotated");
      const { key, raw } = await createKey(tx, existing.clientId, { name: existing.name, scopes: normalizeScopes(existing.scopes as string[]), expiresAt: existing.expiresAt });
      await audit(tx, "apiKey.rotate", existing.client, key);
      return { apiKey: publicKey(key), rawKey: raw, revokedKeyId: id };
    });
  }
  async revokeKey(id: string) {
    return this.prisma.$transaction(async tx => {
      const existing = await tx.apiKey.findUnique({ where: { id }, include: { client: { include: { tenant: true } } } });
      if (!existing) throw new NotFoundException("API key not found");
      const changed = await tx.apiKey.updateMany({ where: { id, clientId: existing.clientId, isActive: true }, data: { isActive: false, revokedAt: new Date() } });
      if (changed.count) await audit(tx, "apiKey.revoke", existing.client, existing);
      const key = await tx.apiKey.findUniqueOrThrow({ where: { id } });
      return { apiKey: publicKey(key) };
    });
  }
}
