import { PrismaClient } from "@prisma/client";

const apiBaseUrl = process.env.VERIFICATION_API_URL || "http://localhost:3000";
const firstApiKey = process.env.DEV_PLATFORM_API_KEY || "dev-gig-platform-key-change-me";
const secondApiKey = process.env.DEV_SECOND_PLATFORM_API_KEY || "dev-partner-platform-key-change-me";
const prisma = new PrismaClient();

async function request(path: string, apiKey?: string) {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    headers: apiKey ? { "X-API-Key": apiKey } : undefined
  });
  const text = await response.text();
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { /* keep text */ }
  return { response, body };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main(): Promise<void> {
  const unauthenticated = await request("/v1/packages");
  assert(unauthenticated.response.status === 401, `Expected unauthenticated request to return 401, got ${unauthenticated.response.status}`);

  const packages = await request("/v1/packages", firstApiKey);
  assert(packages.response.ok, `Package catalogue failed: ${JSON.stringify(packages.body)}`);
  assert(Array.isArray(packages.body) && packages.body.length === 6, "Expected six active verification packages");

  const ownedApplication = await prisma.application.findFirst({
    where: { tenantId: "tenant_keystone", clientId: "client_keystone_worker_portal" },
    orderBy: { createdAt: "desc" },
    select: { id: true }
  });
  assert(ownedApplication, "Expected at least one backfilled Keystone application for isolation testing");

  const ownerRead = await request(`/v1/applications/${ownedApplication.id}/verifications`, firstApiKey);
  assert(ownerRead.response.ok, `Owning client could not read its application: ${JSON.stringify(ownerRead.body)}`);

  const crossTenantRead = await request(`/v1/applications/${ownedApplication.id}/verifications`, secondApiKey);
  assert(crossTenantRead.response.status === 404, `Cross-tenant read must return 404, got ${crossTenantRead.response.status}`);

  console.log("Multi-tenant smoke tests passed");
  console.log(JSON.stringify({
    packages: (packages.body as Array<{ code: string }>).map((item) => item.code),
    ownerReadStatus: ownerRead.response.status,
    crossTenantReadStatus: crossTenantRead.response.status
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
