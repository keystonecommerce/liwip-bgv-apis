import { createParamDecorator, ExecutionContext, SetMetadata } from "@nestjs/common";
import type { PrismaClient } from "@prisma/client";
import { ScopedPrisma, withTenantScope } from "../../common/database/tenant-prisma";
import type { BindingLike, PermissionKey } from "./admin-permissions";

/** Where the current request acts, resolved once by AdminAccessGuard. */
export type AdminScope =
  | { kind: "NONE" }
  | { kind: "GLOBAL" }
  | { kind: "PARTNER"; tenantId: string; tenantSlug: string }
  | { kind: "ALL_PARTNERS" }
  | { kind: "VENDOR"; vendorId: string }
  | { kind: "ALL_VENDORS" };

export interface AdminBinding extends BindingLike {
  id: string;
  roleKey: string;
  scopeType: string;
  tenantId: string | null;
  vendorId: string | null;
}

/** What a handler may add to the request's audit row. */
export interface AdminAuditNote {
  tenantId?: string | null;
  clientId?: string | null;
  resourceType?: string;
  resourceId?: string | null;
  metadata?: Record<string, unknown>;
}

export interface AdminContext {
  user: { id: string; email: string; displayName: string };
  sessionId: string;
  authMethod: string;
  authTime: Date;
  /** Last sign-in or confirmation; @RecentSignIn routes need it to be recent. */
  verifiedAt: Date;
  bindings: AdminBinding[];
  scope: AdminScope;
  /** Permissions held at `scope`. */
  permissions: Set<PermissionKey>;
  audit: AdminAuditNote;
}

export type AdminRequest = {
  method: string;
  headers: Record<string, string | string[] | undefined>;
  params?: Record<string, string>;
  route?: { path?: string };
  ip?: string;
  socket?: { remoteAddress?: string };
  admin?: AdminContext;
};

export const ADMIN_PERMISSION = "admin_permission";
export const ADMIN_SIGNED_IN = "admin_signed_in";
export const ADMIN_AUDIT = "admin_audit";
export const ADMIN_RECENT = "admin_recent_sign_in";

export interface PermissionRule {
  permission: PermissionKey;
  /** Global staff may call this without x-partner-id to work across every partner. */
  allPartners?: boolean;
  /** Global staff may call this without x-vendor-id to work across every vendor. */
  allVendors?: boolean;
}

/** The permission a route needs. Its scope (GLOBAL, PARTNER or VENDOR) comes from the permission. */
export const RequirePermission = (permission: PermissionKey, options: Omit<PermissionRule, "permission"> = {}) =>
  SetMetadata(ADMIN_PERMISSION, { permission, ...options } satisfies PermissionRule);

/**
 * A powerful action: the session must have signed in or confirmed it is them (email code or
 * passkey) within ADMIN_RECENT_SIGN_IN_MINUTES. Otherwise 403 with code RECENT_SIGN_IN_REQUIRED,
 * and the panel asks them to confirm, then retries. Sessions themselves still last 12 hours.
 */
export const RecentSignIn = () => SetMetadata(ADMIN_RECENT, true);

/** Any signed-in staff account (own session, passkeys, card lookups decided in the handler). */
export const SignedIn = () => SetMetadata(ADMIN_SIGNED_IN, true);

export interface AuditRule { action: string; resourceType?: string; resourceParam?: string; skip?: boolean }
/** Names the audit action recorded for this route (default: METHOD path). */
export const AuditAction = (action: string, options: Omit<AuditRule, "action"> = {}) => SetMetadata(ADMIN_AUDIT, { action, ...options } satisfies AuditRule);
export const SkipAudit = () => SetMetadata(ADMIN_AUDIT, { action: "", skip: true } satisfies AuditRule);

export const CurrentAdmin = createParamDecorator((_data: unknown, context: ExecutionContext): AdminContext => {
  const admin = context.switchToHttp().getRequest<AdminRequest>().admin;
  if (!admin) throw new Error("Admin context is missing");
  return admin;
});

/**
 * The database as the current admin may see it. Partner scope always goes through the
 * scoped client; only global staff working across every partner get the plain client.
 */
export function partnerDb(prisma: PrismaClient, admin: AdminContext): ScopedPrisma {
  if (admin.scope.kind === "PARTNER") return withTenantScope(prisma, { tenantId: admin.scope.tenantId, allPrograms: true });
  if (admin.scope.kind === "ALL_PARTNERS") return prisma as unknown as ScopedPrisma;
  throw new Error(`No partner scope on this request (${admin.scope.kind})`);
}

/** The partner the request is limited to, or null when global staff work across every partner. */
export function scopedTenantId(admin: AdminContext): string | null {
  if (admin.scope.kind === "PARTNER") return admin.scope.tenantId;
  if (admin.scope.kind === "ALL_PARTNERS") return null;
  throw new Error(`No partner scope on this request (${admin.scope.kind})`);
}
