import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

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

// Locate a key by --key-id or --key-prefix (e.g. gv_x7Qk9m).
async function findKey() {
  const id = args.get("key-id")?.trim();
  const prefix = args.get("key-prefix")?.trim();
  if (id) return prisma.apiKey.findUnique({ where: { id }, include: { client: { include: { tenant: true } } } });
  if (prefix) {
    const matches = await prisma.apiKey.findMany({ where: { keyPrefix: prefix }, include: { client: { include: { tenant: true } } } });
    if (matches.length > 1) throw new Error(`Prefix ${prefix} matches ${matches.length} keys; use --key-id`);
    return matches[0] ?? null;
  }
  throw new Error("Provide --key-id or --key-prefix");
}

async function main(): Promise<void> {
  const existing = await findKey();
  if (!existing) throw new Error("API key not found");

  await prisma.apiKey.update({ where: { id: existing.id }, data: { isActive: false, revokedAt: new Date() } });
  await prisma.auditLog.create({
    data: {
      id: `audit_${randomUUID()}`,
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
      message: "Revoked via CLI"
    }
  });

  console.log(`Revoked key ${existing.keyPrefix}… (${existing.id}) for ${existing.client.tenant.slug}/${existing.client.code}.`);
}

main()
  .catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
