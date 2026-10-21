import type { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

/** Liwip Direct: the tenant for individuals who sign up without a partner's corporate code. */
export async function ensureLiwipDirect(prisma: PrismaClient) {
  const tenant = await prisma.tenant.upsert({
    where: { slug: "liwip-direct" },
    update: { kind: "DIRECT", status: "ACTIVE" },
    create: { id: "tenant_liwip_direct", slug: "liwip-direct", name: "Liwip Direct", kind: "DIRECT", legalName: "Keystone Commerce Private Limited", status: "ACTIVE" }
  });
  const program = await prisma.client.upsert({
    where: { tenantId_code: { tenantId: tenant.id, code: "INDIVIDUAL" } },
    update: { status: "ACTIVE" },
    create: { id: "client_liwip_direct_individual", tenantId: tenant.id, code: "INDIVIDUAL", name: "Individuals", description: "Workers verifying themselves without a corporate code.", status: "ACTIVE" }
  });
  return { tenant, program };
}

/**
 * Creates (or reuses) a staff account and binds the Keystone platform admin role. The first
 * admin can only come from here (seed or `npm run admin:provision`); after that, admins
 * invite everyone else from the panel.
 */
export async function provisionPlatformAdmin(prisma: PrismaClient, emailInput: string, displayName = "Keystone admin") {
  const email = emailInput.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw new Error("A valid email is required");
  const user = await prisma.portalUser.upsert({
    where: { email },
    update: { status: "ACTIVE" },
    create: { id: `staff_${randomUUID()}`, email, displayName, status: "ACTIVE" }
  });
  await prisma.staffRoleBinding.upsert({
    where: { userId_roleKey_scopeKey: { userId: user.id, roleKey: "KEYSTONE_PLATFORM_ADMIN", scopeKey: "GLOBAL" } },
    update: {},
    create: { id: `binding_${randomUUID()}`, userId: user.id, roleKey: "KEYSTONE_PLATFORM_ADMIN", scopeType: "GLOBAL", scopeKey: "GLOBAL" }
  });
  return user;
}
