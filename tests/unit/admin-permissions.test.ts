import "reflect-metadata";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BindingLike,
  PERMISSIONS,
  SYSTEM_ROLES,
  boundPartnerIds,
  canGrant,
  hasPermission,
  resolvePermissions,
  systemRole
} from "../../apps/verification-api/src/modules/admin-access/admin-permissions";
import { cardStatus, checkState, passedCategories, publicCardView } from "../../apps/verification-api/src/modules/cards/card-views";
import { readCookie } from "../../apps/verification-api/src/modules/admin-access/admin-config";

const global = (roleKey: string): BindingLike => ({ roleKey, scopeType: "GLOBAL", tenantId: null, vendorId: null });
const partner = (roleKey: string, tenantId: string): BindingLike => ({ roleKey, scopeType: "PARTNER", tenantId, vendorId: null });
const vendor = (roleKey: string, vendorId: string): BindingLike => ({ roleKey, scopeType: "VENDOR", tenantId: null, vendorId });
const A = { kind: "PARTNER" as const, tenantId: "tenant_a" };
const B = { kind: "PARTNER" as const, tenantId: "tenant_b" };

test("permission keys are domain.resource.action style and unique", () => {
  const keys = PERMISSIONS.map((item) => item.key);
  assert.equal(new Set(keys).size, keys.length);
  for (const key of keys) assert.match(key, /^[a-z]+(\.[a-z_]+){1,2}$/, key);
});

test("every system role only lists known permissions, and partner/vendor roles only hold their scope's permissions", () => {
  const known = new Set<string>(PERMISSIONS.map((item) => item.key));
  for (const role of SYSTEM_ROLES) {
    for (const key of role.permissions) assert.ok(known.has(key), `${role.key}: ${key}`);
    if (role.scope !== "GLOBAL") {
      for (const key of role.permissions) assert.equal(PERMISSIONS.find((item) => item.key === key)?.scope, role.scope, `${role.key}: ${key}`);
    }
  }
});

test("a partner binding grants partner permissions for that partner only", () => {
  const bindings = [partner("PARTNER_ADMIN", "tenant_a")];
  assert.ok(hasPermission(bindings, "cases.read", A));
  assert.ok(hasPermission(bindings, "users.manage", A));
  assert.equal(hasPermission(bindings, "cases.read", B), false);
  assert.equal(hasPermission(bindings, "cases.read", { kind: "ALL_PARTNERS" }), false);
  assert.equal(hasPermission(bindings, "partners.read", { kind: "GLOBAL" }), false);
  assert.deepEqual(boundPartnerIds(bindings, "cases.read"), ["tenant_a"]);
});

test("a global binding reaches every partner, and global permissions only at GLOBAL", () => {
  const bindings = [global("KEYSTONE_OPS_REVIEWER")];
  assert.ok(hasPermission(bindings, "cases.decide", A));
  assert.ok(hasPermission(bindings, "cases.decide", B));
  assert.ok(hasPermission(bindings, "cases.read", { kind: "ALL_PARTNERS" }));
  assert.ok(hasPermission(bindings, "partners.read", { kind: "GLOBAL" }));
  assert.equal(hasPermission(bindings, "partners.read", A), false, "a GLOBAL permission is not checked at partner scope");
  assert.equal(hasPermission(bindings, "partners.manage", { kind: "GLOBAL" }), false);
  assert.deepEqual(boundPartnerIds(bindings, "cases.read"), [], "global reach is not a partner binding");
});

test("bindings at the wrong scope, unknown roles and missing scope ids grant nothing", () => {
  assert.equal(resolvePermissions([{ roleKey: "PARTNER_ADMIN", scopeType: "GLOBAL" }], A).size, 0, "partner role bound globally");
  assert.equal(resolvePermissions([{ roleKey: "KEYSTONE_PLATFORM_ADMIN", scopeType: "PARTNER", tenantId: "tenant_a" }], A).size, 0, "global role bound to a partner");
  assert.equal(resolvePermissions([{ roleKey: "SUPER_ADMIN", scopeType: "GLOBAL" }], { kind: "GLOBAL" }).size, 0, "unknown/legacy role");
  assert.equal(resolvePermissions([{ roleKey: "PARTNER_ADMIN", scopeType: "PARTNER", tenantId: null }], A).size, 0);
  assert.equal(resolvePermissions([], A).size, 0);
});

test("vendor bindings stay inside their vendor", () => {
  const bindings = [vendor("FIELD_AGENT", "vendor_1")];
  assert.ok(hasPermission(bindings, "field.tasks.perform", { kind: "VENDOR", vendorId: "vendor_1" }));
  assert.equal(hasPermission(bindings, "field.tasks.perform", { kind: "VENDOR", vendorId: "vendor_2" }), false);
  assert.equal(hasPermission(bindings, "cases.read", A), false);
});

test("the verifier role can only verify cards", () => {
  const permissions = resolvePermissions([global("VERIFIER")], { kind: "GLOBAL" });
  assert.deepEqual([...permissions], ["cards.verify"]);
  assert.equal(resolvePermissions([global("VERIFIER")], { kind: "ALL_PARTNERS" }).size, 0);
});

test("read-only Keystone staff get no write permission and no documents", () => {
  const role = systemRole("KEYSTONE_READ_ONLY")!;
  for (const key of role.permissions) assert.equal(PERMISSIONS.find((item) => item.key === key)?.readOnly, true, key);
  assert.ok(!role.permissions.includes("cases.documents.read" as never));
});

test("escalation: a partner admin can grant partner roles at their own partner only", () => {
  const actor = [partner("PARTNER_ADMIN", "tenant_a")];
  assert.deepEqual(canGrant(actor, { roleKey: "PARTNER_OPERATOR", scopeType: "PARTNER", tenantId: "tenant_a" }), { allowed: true });
  assert.deepEqual(canGrant(actor, { roleKey: "PARTNER_VIEWER", scopeType: "PARTNER", tenantId: "tenant_a" }), { allowed: true });
  assert.deepEqual(canGrant(actor, { roleKey: "PARTNER_ADMIN", scopeType: "PARTNER", tenantId: "tenant_a" }), { allowed: true });
  assert.equal(canGrant(actor, { roleKey: "PARTNER_OPERATOR", scopeType: "PARTNER", tenantId: "tenant_b" }).allowed, false, "other partner");
  assert.equal(canGrant(actor, { roleKey: "KEYSTONE_OPS_REVIEWER", scopeType: "GLOBAL" }).allowed, false, "global role");
  assert.equal(canGrant(actor, { roleKey: "PARTNER_ADMIN", scopeType: "GLOBAL" }).allowed, false, "partner role at global scope");
  assert.equal(canGrant(actor, { roleKey: "VENDOR_ADMIN", scopeType: "VENDOR", vendorId: "vendor_1" }).allowed, false);
  assert.equal(canGrant(actor, { roleKey: "VERIFIER", scopeType: "GLOBAL" }).allowed, false);
});

test("escalation: without users.manage nobody grants, and nobody grants permissions they lack", () => {
  assert.equal(canGrant([partner("PARTNER_OPERATOR", "tenant_a")], { roleKey: "PARTNER_VIEWER", scopeType: "PARTNER", tenantId: "tenant_a" }).allowed, false);
  // Ops reviewers can decide checks but cannot manage partner users or Keystone staff.
  assert.equal(canGrant([global("KEYSTONE_OPS_REVIEWER")], { roleKey: "PARTNER_VIEWER", scopeType: "PARTNER", tenantId: "tenant_a" }).allowed, false);
  assert.equal(canGrant([global("KEYSTONE_OPS_REVIEWER")], { roleKey: "KEYSTONE_READ_ONLY", scopeType: "GLOBAL" }).allowed, false);
  // A partner admin bound at two partners still cannot grant a role they hold nowhere.
  const decision = canGrant([partner("PARTNER_ADMIN", "tenant_a"), partner("PARTNER_ADMIN", "tenant_b")], { roleKey: "KEYSTONE_FINANCE", scopeType: "GLOBAL" });
  assert.equal(decision.allowed, false);
});

test("escalation: a role's partner permissions must be held for every partner to grant it globally", () => {
  // Holding PARTNER_ADMIN at one partner does not let anyone hand out cross-partner reach.
  const actor = [global("KEYSTONE_PLATFORM_ADMIN")];
  assert.deepEqual(canGrant(actor, { roleKey: "KEYSTONE_OPS_REVIEWER", scopeType: "GLOBAL" }), { allowed: true });
  assert.deepEqual(canGrant(actor, { roleKey: "VERIFIER", scopeType: "GLOBAL" }), { allowed: true });
  assert.deepEqual(canGrant(actor, { roleKey: "PARTNER_ADMIN", scopeType: "PARTNER", tenantId: "tenant_z" }), { allowed: true });
  assert.deepEqual(canGrant(actor, { roleKey: "FIELD_AGENT", scopeType: "VENDOR", vendorId: "vendor_1" }), { allowed: true });
  const decision = canGrant([partner("PARTNER_ADMIN", "tenant_a")], { roleKey: "KEYSTONE_READ_ONLY", scopeType: "GLOBAL" });
  assert.equal(decision.allowed, false);
});

test("escalation: scope shape is enforced", () => {
  const actor = [global("KEYSTONE_PLATFORM_ADMIN")];
  assert.equal(canGrant(actor, { roleKey: "PARTNER_ADMIN", scopeType: "PARTNER" }).allowed, false, "missing partner");
  assert.equal(canGrant(actor, { roleKey: "PARTNER_ADMIN", scopeType: "PARTNER", tenantId: "a", vendorId: "v" }).allowed, false);
  assert.equal(canGrant(actor, { roleKey: "KEYSTONE_FINANCE", scopeType: "GLOBAL", tenantId: "a" }).allowed, false);
  assert.equal(canGrant(actor, { roleKey: "NOT_A_ROLE", scopeType: "GLOBAL" }).allowed, false);
});

test("vendor admins manage only their own vendor's agents", () => {
  const actor = [vendor("VENDOR_ADMIN", "vendor_1")];
  assert.deepEqual(canGrant(actor, { roleKey: "FIELD_AGENT", scopeType: "VENDOR", vendorId: "vendor_1" }), { allowed: true });
  assert.equal(canGrant(actor, { roleKey: "FIELD_AGENT", scopeType: "VENDOR", vendorId: "vendor_2" }).allowed, false);
  assert.equal(canGrant([vendor("FIELD_AGENT", "vendor_1")], { roleKey: "FIELD_AGENT", scopeType: "VENDOR", vendorId: "vendor_1" }).allowed, false);
});

test("check states and passed categories for card views", () => {
  assert.equal(checkState("VERIFIED"), "CLEAR");
  assert.equal(checkState("FAILED"), "DISCREPANCY");
  assert.equal(checkState("MANUAL_REVIEW"), "NEEDS_REVIEW");
  assert.equal(checkState("QUEUED"), "IN_PROGRESS");
  assert.equal(checkState("PENDING"), "WAITING");
  assert.deepEqual(passedCategories([{ type: "PAN", status: "VERIFIED" }, { type: "AADHAAR", status: "VERIFIED" }, { type: "DRIVING_LICENSE", status: "FAILED" }, { type: "ECOURTS_SEARCH", status: "MANUAL_REVIEW" }]), ["IDENTITY"]);
  assert.deepEqual(passedCategories([{ type: "PAN", status: "VERIFIED" }, { type: "VOTER_ID", status: "FAILED" }]), [], "a failed check in a category withholds it");
});

test("card status follows the card and its checks", () => {
  const year = new Date(Date.now() + 365 * 86_400_000);
  assert.equal(cardStatus({ status: "ACTIVE", expiresAt: year }, [{ status: "VERIFIED" }]), "valid");
  assert.equal(cardStatus({ status: "ACTIVE", expiresAt: year }, [{ status: "PROCESSING" }]), "updating");
  assert.equal(cardStatus({ status: "ACTIVE", expiresAt: new Date(Date.now() + 86_400_000) }, []), "expiring");
  assert.equal(cardStatus({ status: "ACTIVE", expiresAt: new Date(Date.now() - 1) }, []), "expired");
  assert.equal(cardStatus({ status: "SUSPENDED", expiresAt: year }, []), "suspended");
});

test("the public card view carries only the minimal fields", () => {
  const now = new Date();
  const view = publicCardView({
    card: { cardNumber: "LIWIP-2026-ABCDEF1234", status: "ACTIVE", issuedAt: now, expiresAt: new Date(Date.now() + 365 * 86_400_000) },
    checks: [{ type: "PAN", status: "VERIFIED", createdAt: now, updatedAt: now, completedAt: now }],
    data: { personal: { phone: "9876543210", nameAsAadhaar: "Asha Rao", dateOfBirth: "1990-01-01", panNumber: "ABCDE1234F", submittedAddress: "12 MG Road" }, identity: { fullName: "Asha Rao", address: "12 MG Road" } },
    photo: null
  });
  assert.deepEqual(Object.keys(view).sort(), ["checksPassed", "name", "photo", "status", "valid", "validUntil", "view"]);
  const body = JSON.stringify(view);
  for (const secret of ["9876543210", "1990-01-01", "ABCDE1234F", "MG Road", "LIWIP-2026"]) assert.ok(!body.includes(secret), secret);
});

test("session cookie parsing", () => {
  assert.equal(readCookie("a=1; __Host-liwip_admin=abc%2Ddef; b=2", "__Host-liwip_admin"), "abc-def");
  assert.equal(readCookie("liwip_admin_other=x", "liwip_admin"), undefined);
  assert.equal(readCookie(undefined, "x"), undefined);
});
