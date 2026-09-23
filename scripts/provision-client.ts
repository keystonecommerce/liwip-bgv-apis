import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { ALL_SCOPES, generateApiKey, normalizeScopes } from "../apps/verification-api/src/common/security/api-key.util";

const prisma = new PrismaClient();
const args = new Map<string, string>();
for (let index = 2; index < process.argv.length; index += 1) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  if (key.startsWith("--") && value && !value.startsWith("--")) {
    args.set(key.slice(2), value);
    index += 1;
  }
}

const required = (name: string): string => {
  const value = args.get(name)?.trim();
  if (!value) throw new Error(`--${name} is required`);
  return value;
};

async function main(): Promise<void> {
  const tenantSlug = required("tenant-slug").toLowerCase();
  const tenantName = required("tenant-name");
  const clientCode = required("client-code").toUpperCase();
  const clientName = required("client-name");

  // --scopes "applications:write,applications:read"  (defaults to all scopes)
  const scopesArg = args.get("scopes");
  const scopes = normalizeScopes(scopesArg ? scopesArg.split(",") : undefined);

  // --expires-in-days 90  (optional; key never expires if omitted)
  const daysArg = args.get("expires-in-days");
  let expiresAt: Date | null = null;
  if (daysArg) {
    const days = Number(daysArg);
    if (!Number.isFinite(days) || days <= 0) throw new Error("--expires-in-days must be a positive number");
    expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  }

  const { raw, keyHash, keyPrefix } = generateApiKey();

  const tenant = await prisma.tenant.upsert({
    where: { slug: tenantSlug },
    update: { name: tenantName, status: "ACTIVE" },
    create: { id: `tenant_${randomUUID()}`, slug: tenantSlug, name: tenantName, status: "ACTIVE" }
  });
  const client = await prisma.client.upsert({
    where: { tenantId_code: { tenantId: tenant.id, code: clientCode } },
    update: { name: clientName, status: "ACTIVE" },
    create: { id: `client_${randomUUID()}`, tenantId: tenant.id, code: clientCode, name: clientName, status: "ACTIVE" }
  });
  const apiKey = await prisma.apiKey.create({
    data: {
      id: `api_key_${randomUUID()}`,
      clientId: client.id,
      name: args.get("key-name") || "Platform API key",
      keyPrefix,
      keyHash,
      scopes,
      expiresAt
    }
  });

  await prisma.auditLog.create({
    data: {
      id: `audit_${randomUUID()}`,
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
      message: `Provisioned via CLI with scopes: ${scopes.join(", ")}`
    }
  });

  console.log("Tenant/client provisioned successfully.");
  console.log(`Tenant: ${tenant.slug}`);
  console.log(`Client: ${client.code}`);
  console.log(`Scopes: ${scopes.join(", ")}`);
  console.log(`Expires: ${expiresAt ? expiresAt.toISOString() : "never"}`);
  console.log(`API key (shown once): ${raw}`);
  console.log(`\nValid scopes: ${ALL_SCOPES.join(", ")}`);
}

main()
  .catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
