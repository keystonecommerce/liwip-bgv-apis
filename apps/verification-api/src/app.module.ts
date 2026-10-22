import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerModule } from "@nestjs/throttler";
import { PartnerThrottlerGuard } from "./common/security/partner-throttler.guard";
import { AuditModule } from "./common/audit/audit.module";
import { AuthModule } from "./common/auth/auth.module";
import { DatabaseModule } from "./common/database/database.module";
import { AadhaarOvseModule } from "./modules/aadhaar-ovse/aadhaar-ovse.module";
import { WorkerCaseModule } from "./modules/worker-cases/worker-case.module";
import { CardModule } from "./modules/cards/card.module";
import { AdminAccessModule } from "./modules/admin-access/admin-access.module";
import { AdminPanelModule } from "./modules/admin-panel/admin-panel.module";
import { BillingModule } from "./modules/billing/billing.module";
import { StaffAuthModule } from "./modules/staff-auth/staff-auth.module";
import { DigiLockerModule } from "./modules/digilocker/digilocker.module";
import { DocumentStorageModule } from "./modules/document-storage/document-storage.module";
import { FieldTasksModule } from "./modules/field-tasks/field-tasks.module";
import { PlatformModule } from "./modules/platform/platform.module";
import { UsageModule } from "./modules/usage/usage.module";
import { VerificationModule } from "./modules/verifications/verification.module";
import { WorkerAuthModule } from "./modules/worker-auth/worker-auth.module";
import { WebhooksModule } from "./modules/webhooks/webhooks.module";
import { HealthController } from "./common/health.controller";

// Global default rate limit for every route (per client IP). Tune via env.
const throttleTtlMs = Number(process.env.THROTTLE_TTL_SECONDS || 60) * 1000;
const throttleLimit = Number(process.env.THROTTLE_LIMIT || 120);

@Module({
  imports: [
    ThrottlerModule.forRoot([{ ttl: throttleTtlMs, limit: throttleLimit }]),
    DatabaseModule,
    AuditModule,
    AuthModule,
    WorkerAuthModule,
    VerificationModule,
    AadhaarOvseModule,
    DigiLockerModule,
    DocumentStorageModule,
    FieldTasksModule,
    PlatformModule,
    UsageModule,
    AdminAccessModule,
    StaffAuthModule,
    AdminPanelModule,
    BillingModule,
    WorkerCaseModule,
    CardModule,
    WebhooksModule,
  ],
  controllers: [HealthController],
  // Keyed on req.ip, which "trust proxy" in main.ts resolves to the real client. Keying on the
  // presented API key let anyone dodge the limit by sending random keys.
  providers: [{ provide: APP_GUARD, useClass: PartnerThrottlerGuard }],
})
export class AppModule {}
