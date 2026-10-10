import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { generateApiKey } from "../apps/verification-api/src/common/security/api-key.util";

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

  const { raw, keyHash, keyPrefix } = generateApiKey();
  const created = await prisma.apiKey.create({
    data: {
      id: `api_key_${randomUUID()}`,
      clientId: existing.clientId,
      name: existing.name,
      keyPrefix,
      keyHash,
      scopes: existing.scopes as string[],
      expiresAt: existing.expiresAt
    }
  });
  await prisma.apiKey.update({ where: { id: existing.id }, data: { isActive: false, revokedAt: new Date() } });

  await prisma.auditLog.create({
    data: {
      id: `audit_${randomUUID()}`,
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
      message: `Rotated from ${existing.keyPrefix} (revoked) via CLI`
    }
  });

  console.log(`Rotated key for ${existing.client.tenant.slug}/${existing.client.code}.`);
  console.log(`Old key ${existing.keyPrefix}… revoked. New key (shown once): ${raw}`);
}

main()
  .catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
