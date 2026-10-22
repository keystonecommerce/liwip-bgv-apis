/**
 * Admin panel permissions and system roles. Access comes only from role bindings
 * (StaffRoleBinding): a role granted at GLOBAL scope (Keystone), at PARTNER scope
 * (one tenant) or at VENDOR scope (one vendor). There is no legacy role path.
 *
 * A permission's scope says where it applies:
 * - GLOBAL permissions apply only through GLOBAL bindings (platform features).
 * - PARTNER permissions apply to one partner through that partner's bindings, or to
 *   every partner through a GLOBAL binding (Keystone staff).
 * - VENDOR permissions likewise, per vendor.
 */
export type PermissionScope = "GLOBAL" | "PARTNER" | "VENDOR";
export type BindingScope = PermissionScope;

export interface PermissionDefinition {
  key: string;
  label: string;
  description: string;
  scope: PermissionScope;
  readOnly: boolean;
}

const permission = (key: string, label: string, description: string, scope: PermissionScope, readOnly = false): PermissionDefinition =>
  ({ key, label, description, scope, readOnly });

export const PERMISSIONS = [
  // Keystone platform (GLOBAL)
  permission("partners.read", "View partners", "View every partner, its company profile and programs.", "GLOBAL", true),
  permission("partners.manage", "Manage partners", "Create, edit and disable partners and programs; invite partner admins.", "GLOBAL"),
  permission("vendors.read", "View vendors", "View field verification vendors.", "GLOBAL", true),
  permission("vendors.manage", "Manage vendors", "Create and disable vendors; invite vendor admins.", "GLOBAL"),
  permission("staff.read", "View Keystone staff", "View Keystone staff accounts and their access.", "GLOBAL", true),
  permission("staff.manage", "Manage Keystone staff", "Invite and disable Keystone staff and change their roles.", "GLOBAL"),
  permission("verifiers.manage", "Manage verifiers", "Create, scope and revoke verifier accounts.", "GLOBAL"),
  permission("cards.verify", "Verify cards", "Look up a Liwip BGV card by QR or card number.", "GLOBAL", true),
  permission("usage.read", "View usage", "View billable verification usage per partner and program.", "GLOBAL", true),
  permission("packages.manage", "Manage packages", "Create, edit, publish and retire packages and choose their add-on checks.", "GLOBAL"),
  permission("pricing.manage", "Manage pricing", "Set check prices, bulk discount tiers and partner prices.", "GLOBAL"),
  permission("revenue.read", "View revenue", "View package and check sales, refunds and outstanding statements.", "GLOBAL", true),
  permission("statements.manage", "Manage statements", "Issue partners' monthly API usage statements and record their payment.", "GLOBAL"),
  permission("orders.refund", "Refund orders", "Refund paid orders.", "GLOBAL"),
  permission("support.manage", "Support tools", "Reopen a person's checks, give them a fresh start, and (test environments) purge person data.", "GLOBAL"),
  permission("seats.adjust", "Adjust seats", "Add or remove a partner's seats by hand, with a reason.", "GLOBAL"),
  // Partner (PARTNER)
  permission("organisation.read", "View company profile", "View the partner's company profile and programs.", "PARTNER", true),
  permission("cases.read", "View cases", "View cases, their checks, card and activity.", "PARTNER", true),
  permission("cases.documents.read", "View documents", "Open documents attached to cases.", "PARTNER", true),
  permission("cases.decide", "Decide checks", "Clear or fail checks that are in review.", "PARTNER"),
  permission("workers.offboard", "Record exits", "End a person's relationship with the partner; the partner keeps history only.", "PARTNER"),
  permission("cards.read", "View cards", "See the full case behind a scanned card of the partner's own people.", "PARTNER", true),
  permission("users.read", "View team", "View the partner's staff accounts.", "PARTNER", true),
  permission("users.manage", "Manage team", "Invite and remove the partner's staff.", "PARTNER"),
  permission("audit.read", "View activity log", "View the partner's audit trail.", "PARTNER", true),
  permission("billing.buy", "Buy verifications", "See prices, get quotes and pay for verification seats.", "PARTNER"),
  permission("orders.read", "View orders", "View orders, payments and invoices.", "PARTNER", true),
  permission("people.invite", "Add people", "Upload people and send verification links, using seats.", "PARTNER"),
  permission("apikeys.manage", "Manage API keys", "Create, rotate and revoke API keys for the partner's programs. A new key is shown once.", "PARTNER"),
  permission("webhooks.manage", "Manage webhooks", "Add, disable and test the endpoints that receive signed case events. A new secret is shown once.", "PARTNER"),
  // Vendor (VENDOR)
  permission("field.tasks.read", "View field tasks", "View field verification tasks.", "VENDOR", true),
  permission("field.tasks.manage", "Assign field tasks", "Assign and reassign field tasks to agents.", "VENDOR"),
  permission("field.tasks.perform", "Perform field tasks", "Accept, visit and submit field tasks.", "VENDOR"),
  permission("vendor.users.manage", "Manage vendor team", "Invite and remove the vendor's agents.", "VENDOR")
] as const satisfies readonly PermissionDefinition[];

export type PermissionKey = (typeof PERMISSIONS)[number]["key"];
const BY_KEY = new Map<string, PermissionDefinition>(PERMISSIONS.map((item) => [item.key, item]));
export const permissionDefinition = (key: string): PermissionDefinition | undefined => BY_KEY.get(key);
const keysFor = (scope: PermissionScope) => PERMISSIONS.filter((item) => item.scope === scope).map(({ key }) => key as PermissionKey);
const readOnly = (keys: PermissionKey[]) => keys.filter((key) => BY_KEY.get(key)?.readOnly);

export interface SystemRole {
  key: string;
  name: string;
  description: string;
  /** Where the role may be bound. */
  scope: BindingScope;
  permissions: readonly PermissionKey[];
}

export const SYSTEM_ROLES = [
  {
    key: "KEYSTONE_PLATFORM_ADMIN", name: "Keystone platform admin", scope: "GLOBAL",
    description: "Full access to every partner, vendor, staff account and verifier.",
    permissions: PERMISSIONS.map(({ key }) => key)
  },
  {
    key: "KEYSTONE_OPS_REVIEWER", name: "Keystone ops reviewer", scope: "GLOBAL",
    description: "Reviews cases for every partner and decides checks in review.",
    permissions: ["partners.read", "vendors.read", "organisation.read", "cases.read", "cases.documents.read", "cases.decide", "cards.read", "audit.read", "field.tasks.read", "field.tasks.manage", "support.manage"]
  },
  {
    key: "KEYSTONE_FINANCE", name: "Keystone finance", scope: "GLOBAL",
    description: "Views revenue and partners' activity, refunds orders and issues usage statements.",
    permissions: ["partners.read", "vendors.read", "usage.read", "organisation.read", "audit.read", "orders.read", "orders.refund", "revenue.read", "statements.manage"]
  },
  {
    key: "KEYSTONE_READ_ONLY", name: "Keystone read-only", scope: "GLOBAL",
    description: "Views everything without changing anything. No documents.",
    permissions: readOnly([...keysFor("GLOBAL"), ...keysFor("PARTNER"), ...keysFor("VENDOR")]).filter((key) => key !== "cases.documents.read" && key !== "cards.verify")
  },
  {
    key: "PARTNER_ADMIN", name: "Partner admin", scope: "PARTNER",
    description: "Manages the partner's team, billing and API keys, and sees every case.",
    permissions: ["organisation.read", "cases.read", "cases.documents.read", "workers.offboard", "cards.read", "users.read", "users.manage", "audit.read", "billing.buy", "orders.read", "people.invite", "apikeys.manage", "webhooks.manage"]
  },
  {
    key: "PARTNER_OPERATOR", name: "Partner operator", scope: "PARTNER",
    description: "Works the partner's cases day to day.",
    permissions: ["organisation.read", "cases.read", "cases.documents.read", "cards.read", "users.read", "people.invite"]
  },
  {
    key: "PARTNER_VIEWER", name: "Partner viewer", scope: "PARTNER",
    description: "Views case status without documents.",
    permissions: ["organisation.read", "cases.read", "cards.read"]
  },
  {
    key: "PARTNER_FINANCE", name: "Partner finance", scope: "PARTNER",
    description: "Buys seats and sees orders, statements and invoices. No verification details.",
    permissions: ["organisation.read", "billing.buy", "orders.read"]
  },
  {
    key: "VENDOR_ADMIN", name: "Vendor admin", scope: "VENDOR",
    description: "Assigns field tasks, can perform them, and manages the vendor's agents.",
    permissions: ["field.tasks.read", "field.tasks.manage", "field.tasks.perform", "vendor.users.manage"]
  },
  {
    key: "FIELD_AGENT", name: "Field agent", scope: "VENDOR",
    description: "Performs ground address and police checks.",
    permissions: ["field.tasks.read", "field.tasks.perform"]
  },
  {
    key: "VERIFIER", name: "Verifier", scope: "GLOBAL",
    description: "Looks up cards by QR or card number only, within the access Keystone granted.",
    permissions: ["cards.verify"]
  }
] as const satisfies readonly SystemRole[];

export type RoleKey = (typeof SYSTEM_ROLES)[number]["key"];
const ROLES = new Map<string, SystemRole>(SYSTEM_ROLES.map((role) => [role.key, role]));
export const systemRole = (key: string): SystemRole | undefined => ROLES.get(key);

/** The parts of a StaffRoleBinding that decide access. */
export interface BindingLike {
  roleKey: string;
  scopeType: string;
  tenantId?: string | null;
  vendorId?: string | null;
}

/**
 * Where a permission is checked: platform-wide, one partner, every partner (global
 * staff working across partners), one vendor or every vendor.
 */
export type AccessTarget =
  | { kind: "GLOBAL" }
  | { kind: "PARTNER"; tenantId: string }
  | { kind: "ALL_PARTNERS" }
  | { kind: "VENDOR"; vendorId: string }
  | { kind: "ALL_VENDORS" };

function bindingReaches(binding: BindingLike, definition: PermissionDefinition, target: AccessTarget): boolean {
  switch (definition.scope) {
    case "GLOBAL":
      return target.kind === "GLOBAL" && binding.scopeType === "GLOBAL";
    case "PARTNER":
      if (target.kind === "ALL_PARTNERS") return binding.scopeType === "GLOBAL";
      if (target.kind !== "PARTNER") return false;
      return binding.scopeType === "GLOBAL" || (binding.scopeType === "PARTNER" && binding.tenantId === target.tenantId);
    case "VENDOR":
      if (target.kind === "ALL_VENDORS") return binding.scopeType === "GLOBAL";
      if (target.kind !== "VENDOR") return false;
      return binding.scopeType === "GLOBAL" || (binding.scopeType === "VENDOR" && binding.vendorId === target.vendorId);
  }
}

/** A binding counts only when its role exists and is bound at the role's own scope. */
const validBinding = (binding: BindingLike): SystemRole | undefined => {
  const role = systemRole(binding.roleKey);
  if (!role || role.scope !== binding.scopeType) return undefined;
  if (binding.scopeType === "PARTNER" && !binding.tenantId) return undefined;
  if (binding.scopeType === "VENDOR" && !binding.vendorId) return undefined;
  return role;
};

/** Every permission the bindings give at `target`. */
export function resolvePermissions(bindings: readonly BindingLike[], target: AccessTarget): Set<PermissionKey> {
  const granted = new Set<PermissionKey>();
  for (const binding of bindings) {
    const role = validBinding(binding);
    if (!role) continue;
    for (const key of role.permissions) {
      const definition = BY_KEY.get(key);
      if (definition && bindingReaches(binding, definition, target)) granted.add(key);
    }
  }
  return granted;
}

export const hasPermission = (bindings: readonly BindingLike[], key: string, target: AccessTarget): boolean =>
  resolvePermissions(bindings, target).has(key as PermissionKey);

/** Partners the bindings reach with `key` through partner bindings (not global ones). */
export function boundPartnerIds(bindings: readonly BindingLike[], key: string): string[] {
  const ids = new Set<string>();
  for (const binding of bindings) {
    if (binding.scopeType !== "PARTNER" || !binding.tenantId) continue;
    if (hasPermission([binding], key, { kind: "PARTNER", tenantId: binding.tenantId })) ids.add(binding.tenantId);
  }
  return [...ids];
}

export function boundVendorIds(bindings: readonly BindingLike[], key: string): string[] {
  const ids = new Set<string>();
  for (const binding of bindings) {
    if (binding.scopeType !== "VENDOR" || !binding.vendorId) continue;
    if (hasPermission([binding], key, { kind: "VENDOR", vendorId: binding.vendorId })) ids.add(binding.vendorId);
  }
  return [...ids];
}

/** The permission an actor needs to grant or remove a role at a scope, besides holding the role's permissions. */
export function managePermissionFor(role: SystemRole): PermissionKey {
  if (role.key === "VERIFIER") return "verifiers.manage";
  if (role.scope === "PARTNER") return "users.manage";
  if (role.scope === "VENDOR") return "vendor.users.manage";
  return "staff.manage";
}

export interface GrantRequest {
  roleKey: string;
  scopeType: string;
  tenantId?: string | null;
  vendorId?: string | null;
}

export type GrantDecision = { allowed: true } | { allowed: false; reason: string };

/**
 * Privilege escalation check. An actor may grant (or remove) a role at a scope only when
 * they hold the right to manage people there AND every permission of that role at that
 * scope. A GLOBAL role's partner and vendor permissions must be held for every partner
 * and vendor, i.e. through the actor's own GLOBAL bindings.
 */
export function canGrant(actor: readonly BindingLike[], grant: GrantRequest): GrantDecision {
  const role = systemRole(grant.roleKey);
  if (!role) return { allowed: false, reason: "Unknown role" };
  if (role.scope !== grant.scopeType) return { allowed: false, reason: `${role.name} can only be granted at ${role.scope} scope` };
  if (grant.scopeType === "PARTNER" && (!grant.tenantId || grant.vendorId)) return { allowed: false, reason: "A partner role needs exactly one partner" };
  if (grant.scopeType === "VENDOR" && (!grant.vendorId || grant.tenantId)) return { allowed: false, reason: "A vendor role needs exactly one vendor" };
  if (grant.scopeType === "GLOBAL" && (grant.tenantId || grant.vendorId)) return { allowed: false, reason: "A global role has no partner or vendor" };

  const targetFor = (scope: PermissionScope): AccessTarget => {
    if (scope === "GLOBAL") return { kind: "GLOBAL" };
    if (scope === "PARTNER") return grant.scopeType === "PARTNER" ? { kind: "PARTNER", tenantId: grant.tenantId! } : { kind: "ALL_PARTNERS" };
    return grant.scopeType === "VENDOR" ? { kind: "VENDOR", vendorId: grant.vendorId! } : { kind: "ALL_VENDORS" };
  };

  const manage = managePermissionFor(role);
  const manageDefinition = BY_KEY.get(manage)!;
  if (!hasPermission(actor, manage, targetFor(manageDefinition.scope))) return { allowed: false, reason: `Requires ${manage}` };

  const missing = role.permissions.filter((key) => !hasPermission(actor, key, targetFor(BY_KEY.get(key)!.scope)));
  if (missing.length) return { allowed: false, reason: `You cannot grant permissions you do not hold: ${missing.join(", ")}` };
  return { allowed: true };
}

/** Access summary for the admin panel: what to show for each scope. */
export function describeAccess(bindings: readonly BindingLike[]) {
  return {
    global: [...resolvePermissions(bindings, { kind: "GLOBAL" })],
    allPartners: [...resolvePermissions(bindings, { kind: "ALL_PARTNERS" })],
    allVendors: [...resolvePermissions(bindings, { kind: "ALL_VENDORS" })]
  };
}
