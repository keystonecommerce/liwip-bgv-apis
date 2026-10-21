import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../../common/database/prisma.service";
import { ALL_SCOPES } from "../../common/security/api-key.util";
import { PartnerProvisioning } from "../../common/security/partner-provisioning";
import { AdminContext, scopedTenantId } from "../admin-access/admin-context";
import { hasPermission } from "../admin-access/admin-permissions";
import { id, optionalText } from "./input";

/** Scopes only Keystone may grant: the Liwip worker app's own access to people's cases. */
const KEYSTONE_ONLY_SCOPES = new Set(["worker:cases"]);

const SCOPE_LABELS: Record<string, string> = {
  "packages:read": "Read packages and prices",
  "applications:write": "Create and update cases",
  "applications:read": "Read cases and results",
  "verifications:retry": "Retry checks",
  "verifications:review": "Decide checks in review",
  "verifications:write": "Start checks",
  "digilocker:write": "Start DigiLocker sessions",
  "aadhaar:write": "Start Aadhaar verification",
  "aadhaar:read": "Read Aadhaar verification results",
  "otp:write": "Send and verify phone codes",
  "documents:write": "Upload documents",
  "documents:read": "Download documents",
  "usage:read": "Read usage",
  "audit:read": "Read the API activity log",
  "worker:cases": "Liwip worker app (Keystone only)"
};

export interface ApiKeyInput {
  programId?: unknown;
  name?: unknown;
  scopes?: unknown;
  expiresInDays?: unknown;
}

/**
 * API keys from the admin apps. Keystone manages any partner's keys; a partner admin manages
 * their own (apikeys.manage at that partner). A new or rotated key is returned once, never again.
 */
@Injectable()
export class ApiKeysService {
  private readonly provisioning: PartnerProvisioning;

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {
    this.provisioning = new PartnerProvisioning(prisma);
  }

  /** Keystone: apikeys.manage for every partner (a GLOBAL binding). */
  private isKeystone(admin: AdminContext) {
    return hasPermission(admin.bindings, "apikeys.manage", { kind: "ALL_PARTNERS" });
  }

  scopes(admin: AdminContext) {
    const keystone = this.isKeystone(admin);
    return { items: ALL_SCOPES.filter((scope) => keystone || !KEYSTONE_ONLY_SCOPES.has(scope)).map((scope) => ({ scope, label: SCOPE_LABELS[scope] ?? scope })) };
  }

  async list(admin: AdminContext, programId?: string) {
    const tenantId = scopedTenantId(admin);
    const keys = await this.prisma.apiKey.findMany({
      where: { client: { ...(tenantId ? { tenantId } : {}), ...(programId ? { id: id(programId, "programId") } : {}) } },
      orderBy: [{ isActive: "desc" }, { createdAt: "desc" }],
      take: 500,
      select: {
        id: true, name: true, keyPrefix: true, scopes: true, isActive: true, expiresAt: true, lastUsedAt: true, revokedAt: true, createdAt: true,
        client: { select: { id: true, code: true, name: true, tenant: { select: { id: true, name: true } } } }
      }
    });
    const now = new Date();
    return {
      items: keys.map(({ client, ...key }) => ({
        ...key,
        scopes: Array.isArray(key.scopes) ? (key.scopes as string[]) : [],
        state: key.revokedAt || !key.isActive ? "REVOKED" : key.expiresAt && key.expiresAt <= now ? "EXPIRED" : "ACTIVE",
        program: { id: client.id, code: client.code, name: client.name },
        partner: client.tenant
      }))
    };
  }

  async create(admin: AdminContext, input: ApiKeyInput) {
    const program = await this.program(admin, id(input?.programId, "programId"));
    const scopes = this.allowedScopes(admin, input?.scopes);
    const days = input?.expiresInDays === undefined || input?.expiresInDays === null ? undefined : Number(input.expiresInDays);
    const created = await this.provisioning.issueKey(program.id, { keyName: optionalText(input?.name, "name", 120) ?? "API key", scopes, expiresInDays: days });
    admin.audit = { tenantId: program.tenantId, resourceType: "ApiKey", resourceId: created.apiKey.id, metadata: { programId: program.id, scopes } };
    return created;
  }

  async rotate(admin: AdminContext, keyId: string) {
    const key = await this.key(admin, keyId);
    const rotated = await this.provisioning.rotateKey(key.id);
    admin.audit = { tenantId: key.client.tenantId, resourceType: "ApiKey", resourceId: rotated.apiKey.id, metadata: { replaced: key.id } };
    return rotated;
  }

  async revoke(admin: AdminContext, keyId: string) {
    const key = await this.key(admin, keyId);
    const revoked = await this.provisioning.revokeKey(key.id);
    admin.audit = { tenantId: key.client.tenantId, resourceType: "ApiKey", resourceId: key.id };
    return revoked;
  }

  /** A program the caller may manage keys for: within the partner in scope, never Liwip Direct for a partner. */
  private async program(admin: AdminContext, programId: string) {
    const tenantId = scopedTenantId(admin);
    const program = await this.prisma.client.findFirst({ where: { id: programId, ...(tenantId ? { tenantId } : {}) }, select: { id: true, tenantId: true, tenant: { select: { kind: true } } } });
    if (!program) throw new NotFoundException("Program not found");
    if (program.tenant.kind === "DIRECT" && !this.isKeystone(admin)) throw new ForbiddenException("Only Keystone manages Liwip keys");
    return program;
  }

  private async key(admin: AdminContext, keyId: string) {
    const tenantId = scopedTenantId(admin);
    const key = await this.prisma.apiKey.findFirst({ where: { id: id(keyId, "keyId"), ...(tenantId ? { client: { tenantId } } : {}) }, select: { id: true, client: { select: { tenantId: true } } } });
    if (!key) throw new NotFoundException("API key not found");
    return key;
  }

  private allowedScopes(admin: AdminContext, value: unknown): string[] {
    if (!Array.isArray(value) || !value.length) throw new BadRequestException("Choose at least one scope");
    const scopes = [...new Set(value.map((scope) => String(scope).trim()))];
    const unknown = scopes.filter((scope) => !(ALL_SCOPES as readonly string[]).includes(scope));
    if (unknown.length) throw new BadRequestException(`Unknown scopes: ${unknown.join(", ")}`);
    if (!this.isKeystone(admin) && scopes.some((scope) => KEYSTONE_ONLY_SCOPES.has(scope))) throw new ForbiddenException("worker:cases is for the Liwip worker app only");
    return scopes;
  }
}
