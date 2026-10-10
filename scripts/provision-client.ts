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
  const tenantName = required("tenant-name");
  const clientCode = required("client-code").toUpperCase();
  const clientName = required("client-name");
  const rawApiKey = `gv_${randomBytes(32).toString("base64url")}`;
  const keyHash = createHash("sha256").update(rawApiKey).digest("hex");

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
  await prisma.apiKey.create({
    data: {
      id: `api_key_${randomUUID()}`,
      clientId: client.id,
      name: args.get("key-name") || "Platform API key",
      keyPrefix: rawApiKey.slice(0, 10),
      keyHash,
      scopes: ["packages:read", "applications:write", "applications:read", "verifications:retry", "verifications:write", "digilocker:write", "aadhaar:write", "aadhaar:read", "otp:write", "documents:write", "documents:read"]
    }
  });

  console.log("Tenant/client provisioned successfully.");
  console.log(`Tenant: ${tenant.slug}`);
  console.log(`Client: ${client.code}`);
  console.log(`API key (shown once): ${rawApiKey}`);
}

main()
  .catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
