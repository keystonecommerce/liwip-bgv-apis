import { PrismaClient } from "@prisma/client";
import { loadEnv } from "../apps/verification-api/src/config/env";
import { provisionPlatformAdmin } from "../apps/verification-api/src/modules/admin-access/bootstrap";

// Usage: npm run admin:provision -- admin@keystonecommerce.in "Display Name"
loadEnv();
const [email, name] = process.argv.slice(2);
const prisma = new PrismaClient();
provisionPlatformAdmin(prisma, email || "", name || undefined)
  .then((user) => console.log(`Platform admin ready: ${user.email} (${user.id}). Sign in to the admin panel with an email code.`))
  .catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
