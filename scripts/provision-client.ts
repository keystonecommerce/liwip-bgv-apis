import { PrismaClient } from "@prisma/client";
import { PartnerProvisioning } from "../apps/verification-api/src/common/security/partner-provisioning";
import { ALL_SCOPES } from "../apps/verification-api/src/common/security/api-key.util";

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

  const result = await new PartnerProvisioning(prisma).createPartner({
    tenantSlug, tenantName, clientCode, clientName,
    keyName: args.get("key-name"),
    scopes: args.has("scopes") ? args.get("scopes")!.split(",") : undefined,
    expiresInDays: args.has("expires-in-days") ? Number(args.get("expires-in-days")) : undefined,
  });
  const { tenant, client, rawKey: raw } = result;
  const { scopes, expiresAt } = result.apiKey;

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

