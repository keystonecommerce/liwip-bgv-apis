import { PrismaClient } from "@prisma/client";
import { createHash, randomBytes, randomUUID } from "node:crypto";

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
  const clientCode = required("client-code").toUpperCase();
  const client = await prisma.client.findFirst({
    where: { code: clientCode, tenant: { slug: tenantSlug }, status: "ACTIVE" },
    include: { tenant: true }
  });
  if (!client) throw new Error(`Active client ${clientCode} was not found in tenant ${tenantSlug}`);

  const rawApiKey = `gv_review_${randomBytes(32).toString("base64url")}`;
  await prisma.apiKey.create({
    data: {
      id: `api_key_${randomUUID()}`,
      clientId: client.id,
      name: args.get("key-name") || "Manual-review API key",
      keyPrefix: rawApiKey.slice(0, 14),
      keyHash: createHash("sha256").update(rawApiKey).digest("hex"),
      scopes: ["applications:read", "verifications:review"]
    }
  });

  console.log("Reviewer credential provisioned successfully.");
  console.log(`Tenant: ${client.tenant.slug}`);
  console.log(`Client: ${client.code}`);
  console.log(`Reviewer API key (shown once): ${rawApiKey}`);
}

main()
  .catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
