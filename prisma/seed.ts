import { PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";

const prisma = new PrismaClient();

const provider = (type: string) => ({ type, mode: "REQUIRED", execution: "PROVIDER" });
const manual = (type: string) => ({ type, mode: "REQUIRED", execution: "MANUAL" });

const basicChecks = [
  provider("PAN"),
  provider("FACE_LIVENESS"),
  provider("FACE_MATCH"),
  manual("CURRENT_ADDRESS")
];

const riderChecks = [
  ...basicChecks,
  provider("DRIVING_LICENSE"),
  provider("RC_V2"),
  provider("ECOURTS_SEARCH")
];

const packages = [
  {
    id: "package_basic_id_v1",
    code: "BASIC_ID",
    version: 1,
    name: "Basic ID",
    description: "Identity, face/liveness and current-address verification.",
    priceInr: 199,
    advertisedCheckCount: 3,
    targetWorkforce: "Low-risk temporary workforce",
    displayOrder: 1,
    kind: "BASE",
    checks: basicChecks
  },
  {
    id: "package_rider_v1",
    code: "RIDER",
    version: 1,
    name: "Rider",
    description: "Basic ID plus driving licence, RC, insurance, PUC and court screening.",
    priceInr: 449,
    advertisedCheckCount: 8,
    targetWorkforce: "Delivery and bike logistics",
    displayOrder: 2,
    kind: "BASE",
    checks: riderChecks
  },
  {
    id: "package_driver_v1",
    code: "DRIVER",
    version: 1,
    name: "Driver",
    description: "Rider verification plus a personal or professional reference check.",
    priceInr: 549,
    advertisedCheckCount: 9,
    targetWorkforce: "Auto, taxi and cab drivers",
    displayOrder: 3,
    kind: "BASE",
    checks: [...riderChecks, manual("REFERENCE_CHECK")]
  },
  {
    id: "package_home_services_v1",
    code: "HOME_SERVICES",
    version: 1,
    name: "Home Services",
    description: "Basic ID plus court screening, references and skill/certification review.",
    priceInr: 499,
    advertisedCheckCount: 7,
    targetWorkforce: "Workers with customer-home access",
    displayOrder: 4,
    kind: "BASE",
    checks: [
      ...basicChecks,
      provider("ECOURTS_SEARCH"),
      manual("REFERENCE_CHECK"),
      manual("SKILL_CERTIFICATION")
    ]
  },
  {
    id: "package_security_v1",
    code: "SECURITY",
    version: 1,
    name: "Security",
    description: "Identity, address, court, current-employment and reference verification for security staffing.",
    priceInr: 599,
    advertisedCheckCount: 8,
    targetWorkforce: "PSARA-linked security staffing",
    displayOrder: 5,
    kind: "BASE",
    checks: [
      ...basicChecks,
      provider("ECOURTS_SEARCH"),
      provider("CURRENT_EMPLOYMENT"),
      manual("REFERENCE_CHECK")
    ]
  },
  {
    id: "package_factory_warehouse_v1",
    code: "FACTORY_WAREHOUSE",
    version: 1,
    name: "Factory / Warehouse",
    description: "Basic ID plus court and current-employment verification.",
    priceInr: 399,
    advertisedCheckCount: 6,
    targetWorkforce: "Factory, fulfilment-centre and warehouse workers",
    displayOrder: 6,
    kind: "BASE",
    checks: [
      ...basicChecks,
      provider("ECOURTS_SEARCH"),
      provider("CURRENT_EMPLOYMENT")
    ]
  }
] as const;

async function main(): Promise<void> {
  const developmentApiKey = process.env.DEV_PLATFORM_API_KEY || "dev-gig-platform-key-change-me";
  const secondDevelopmentApiKey = process.env.DEV_SECOND_PLATFORM_API_KEY || "dev-partner-platform-key-change-me";
  const tenant = await prisma.tenant.upsert({
    where: { slug: "keystone" },
    update: { name: "Keystone", status: "ACTIVE" },
    create: { id: "tenant_keystone", slug: "keystone", name: "Keystone", status: "ACTIVE" }
  });
  const client = await prisma.client.upsert({
    where: { tenantId_code: { tenantId: tenant.id, code: "WORKER_PORTAL" } },
    update: { name: "Keystone Worker Portal", status: "ACTIVE" },
    create: { id: "client_keystone_worker_portal", tenantId: tenant.id, code: "WORKER_PORTAL", name: "Keystone Worker Portal", status: "ACTIVE" }
  });
  const keyHash = createHash("sha256").update(developmentApiKey).digest("hex");
  await prisma.apiKey.upsert({
    where: { keyHash },
    update: { clientId: client.id, name: "Local development key", isActive: true, scopes: ["packages:read", "applications:write", "applications:read", "verifications:retry"] },
    create: { id: "api_key_keystone_local", clientId: client.id, name: "Local development key", keyPrefix: developmentApiKey.slice(0, 8), keyHash, scopes: ["packages:read", "applications:write", "applications:read", "verifications:retry"] }
  });
  const partnerTenant = await prisma.tenant.upsert({
    where: { slug: "demo-partner" },
    update: { name: "Demo Partner", status: "ACTIVE" },
    create: { id: "tenant_demo_partner", slug: "demo-partner", name: "Demo Partner", status: "ACTIVE" }
  });
  const partnerClient = await prisma.client.upsert({
    where: { tenantId_code: { tenantId: partnerTenant.id, code: "PLATFORM" } },
    update: { name: "Demo Partner Platform", status: "ACTIVE" },
    create: { id: "client_demo_partner_platform", tenantId: partnerTenant.id, code: "PLATFORM", name: "Demo Partner Platform", status: "ACTIVE" }
  });
  const partnerKeyHash = createHash("sha256").update(secondDevelopmentApiKey).digest("hex");
  await prisma.apiKey.upsert({
    where: { keyHash: partnerKeyHash },
    update: { clientId: partnerClient.id, name: "Second-tenant development key", isActive: true, scopes: ["packages:read", "applications:write", "applications:read", "verifications:retry"] },
    create: { id: "api_key_demo_partner_local", clientId: partnerClient.id, name: "Second-tenant development key", keyPrefix: secondDevelopmentApiKey.slice(0, 8), keyHash: partnerKeyHash, scopes: ["packages:read", "applications:write", "applications:read", "verifications:retry"] }
  });
  const activeCodes = packages.map((item) => item.code);
  await prisma.verificationPackage.updateMany({
    where: { code: { notIn: activeCodes } },
    data: { isActive: false }
  });

  for (const item of packages) {
    await prisma.verificationPackage.upsert({
      where: { code_version: { code: item.code, version: item.version } },
      update: {
        name: item.name,
        description: item.description,
        kind: item.kind,
        priceInr: item.priceInr,
        advertisedCheckCount: item.advertisedCheckCount,
        targetWorkforce: item.targetWorkforce,
        displayOrder: item.displayOrder,
        isActive: true,
        checks: [...item.checks]
      },
      create: {
        ...item,
        checks: [...item.checks],
        isActive: true
      }
    });
  }
}

main()
  .then(() => console.log(`Seeded two development tenants and ${packages.length} commercial verification packages.`))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
