import { PrismaClient } from "@prisma/client";

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

// Optional filters: --tenant-slug, --client-code. No secrets are ever printed.
async function main(): Promise<void> {
  const tenantSlug = args.get("tenant-slug")?.trim().toLowerCase();
  const clientCode = args.get("client-code")?.trim().toUpperCase();

  const keys = await prisma.apiKey.findMany({
    where: {
      client: {
        ...(clientCode ? { code: clientCode } : {}),
        ...(tenantSlug ? { tenant: { slug: tenantSlug } } : {}),
      },
    },
    include: { client: { include: { tenant: true } } },
    orderBy: { createdAt: "desc" },
  });

  if (!keys.length) {
    console.log("No API keys found for the given filter.");
    return;
  }

  for (const k of keys) {
    const scopes = Array.isArray(k.scopes) ? (k.scopes as unknown[]).map(String) : [];
    const status = !k.isActive ? "REVOKED/INACTIVE" : k.expiresAt && k.expiresAt.getTime() <= Date.now() ? "EXPIRED" : "ACTIVE";
    console.log("—".repeat(60));
    console.log(`${k.client.tenant.slug}/${k.client.code}  ·  ${k.name}`);
    console.log(`  id:        ${k.id}`);
    console.log(`  prefix:    ${k.keyPrefix}…`);
    console.log(`  status:    ${status}`);
    console.log(`  scopes:    ${scopes.join(", ")}`);
    console.log(`  expiresAt: ${k.expiresAt ? k.expiresAt.toISOString() : "never"}`);
    console.log(`  lastUsed:  ${k.lastUsedAt ? k.lastUsedAt.toISOString() : "never"}`);
    console.log(`  revokedAt: ${k.revokedAt ? k.revokedAt.toISOString() : "-"}`);
  }
}

main()
  .catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
