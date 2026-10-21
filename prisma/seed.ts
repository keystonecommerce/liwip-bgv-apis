import { PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";
import { hashPortalPassword } from "../apps/verification-api/src/modules/portal-auth/password";
import { ensureLiwipDirect, provisionPlatformAdmin } from "../apps/verification-api/src/modules/admin-access/bootstrap";

const prisma = new PrismaClient();

const provider = (type: string) => ({ type, mode: "REQUIRED", execution: "PROVIDER" });
const manual = (type: string) => ({ type, mode: "REQUIRED", execution: "MANUAL" });
const developmentScopes = ["packages:read", "applications:write", "applications:read", "verifications:retry", "verifications:write", "digilocker:write", "aadhaar:write", "aadhaar:read", "otp:write", "documents:write", "documents:read", "worker:cases"];

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
      provider("EMPLOYMENT_HISTORY"),
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
      provider("EMPLOYMENT_HISTORY")
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
    update: { clientId: client.id, name: "Local development key", isActive: true, scopes: developmentScopes },
    create: { id: "api_key_keystone_local", clientId: client.id, name: "Local development key", keyPrefix: developmentApiKey.slice(0, 8), keyHash, scopes: developmentScopes }
  });
  const partnerTenant = await prisma.tenant.upsert({
    where: { slug: "demo-partner" },
    update: { name: "Demo Partner", status: "ACTIVE" },
    create: { id: "tenant_demo_partner", slug: "demo-partner", name: "Demo Partner", status: "ACTIVE" }
  });
  const partnerClient = await prisma.client.upsert({
    where: { tenantId_code: { tenantId: partnerTenant.id, code: "PLATFORM" } },
    update: { name: "Demo Partner Platform", status: "ACTIVE", corporateCode: "DEMO-PARTNER" },
    create: { id: "client_demo_partner_platform", tenantId: partnerTenant.id, code: "PLATFORM", name: "Demo Partner Platform", status: "ACTIVE", corporateCode: "DEMO-PARTNER" }
  });
  await ensureLiwipDirect(prisma);
  // Admin panel: the first Keystone platform admin (signs in by email code; dev codes are logged).
  if (process.env.ADMIN_BOOTSTRAP_EMAIL) await provisionPlatformAdmin(prisma, process.env.ADMIN_BOOTSTRAP_EMAIL, "Keystone admin");
  const partnerKeyHash = createHash("sha256").update(secondDevelopmentApiKey).digest("hex");
  await prisma.apiKey.upsert({
    where: { keyHash: partnerKeyHash },
    update: { clientId: partnerClient.id, name: "Second-tenant development key", isActive: true, scopes: developmentScopes },
    create: { id: "api_key_demo_partner_local", clientId: partnerClient.id, name: "Second-tenant development key", keyPrefix: secondDevelopmentApiKey.slice(0, 8), keyHash: partnerKeyHash, scopes: developmentScopes }
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

  const portalUsers = [
    {
      id: "portal_user_demo_company_admin",
      tenantId: partnerTenant.id,
      clientId: partnerClient.id,
      email: process.env.DEV_CORPORATE_ADMIN_EMAIL,
      password: process.env.DEV_CORPORATE_ADMIN_PASSWORD,
      displayName: "Demo Partner Admin",
      role: "CORPORATE_ADMIN"
    },
    {
      id: "portal_user_liwip_support",
      tenantId: tenant.id,
      clientId: undefined,
      email: process.env.DEV_LIWIP_SUPPORT_EMAIL,
      password: process.env.DEV_LIWIP_SUPPORT_PASSWORD,
      displayName: "LIWIP Support",
      role: "LIWIP_SUPPORT"
    },
    {
      id: "portal_user_demo_field_agent",
      tenantId: partnerTenant.id,
      clientId: partnerClient.id,
      email: process.env.DEV_FIELD_AGENT_EMAIL,
      password: process.env.DEV_FIELD_AGENT_PASSWORD,
      displayName: "Demo Field Agent",
      role: "FIELD_AGENT"
    }
  ];

  for (const user of portalUsers) {
    if (!user.email || !user.password) continue;
    const email = user.email.trim().toLowerCase();
    const passwordHash = await hashPortalPassword(user.password);
    await prisma.portalUser.upsert({
      where: { email },
      update: {
        tenantId: user.tenantId,
        clientId: user.clientId,
        displayName: user.displayName,
        passwordHash,
        role: user.role,
        status: "ACTIVE"
      },
      create: {
        id: user.id,
        tenantId: user.tenantId,
        clientId: user.clientId,
        email,
        displayName: user.displayName,
        passwordHash,
        role: user.role,
        status: "ACTIVE"
      }
    });
  }

  // Sample field-verification fixture: a partner-tenant case whose physical-address
  // check awaits a field visit. It surfaces as an available FieldTask for the seeded
  // field agent so the field app has real work on first run.
  const sampleApplicationData = {
    packageCode: "BASIC_ID",
    packageVersion: 1,
    personal: {
      phone: "9990001234",
      nameAsAadhaar: "Rahul Kumar",
      dateOfBirth: "1994-05-20",
      submittedAddress: "12/3, 4th Cross, Indiranagar, Bengaluru, Karnataka 560038"
    },
    consent: {
      granted: true,
      purpose: "Gig-worker identity and address verification",
      textVersion: "worker-verification-v1",
      grantedAt: new Date().toISOString()
    }
  };
  await prisma.application.upsert({
    where: { id: "app_seed_field_demo" },
    update: { status: "MANUAL_REVIEW" },
    create: {
      id: "app_seed_field_demo",
      tenantId: partnerTenant.id,
      clientId: partnerClient.id,
      packageId: "package_basic_id_v1",
      status: "MANUAL_REVIEW",
      data: sampleApplicationData
    }
  });
  await prisma.verification.upsert({
    where: { id: "verification_seed_field_demo" },
    update: { status: "MANUAL_REVIEW" },
    create: {
      id: "verification_seed_field_demo",
      applicationId: "app_seed_field_demo",
      tenantId: partnerTenant.id,
      clientId: partnerClient.id,
      type: "CURRENT_ADDRESS",
      status: "MANUAL_REVIEW",
      provider: "field",
      attemptCount: 0
    }
  });
}

main()
  .then(() => console.log(`Seeded two development tenants and ${packages.length} commercial verification packages.`))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
