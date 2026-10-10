import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { AuditModule } from "./common/audit/audit.module";
import { AuthModule } from "./common/auth/auth.module";
import { DatabaseModule } from "./common/database/database.module";
import { AadhaarOvseModule } from "./modules/aadhaar-ovse/aadhaar-ovse.module";
import { AdminModule } from "./modules/admin/admin.module";
import { DigiLockerModule } from "./modules/digilocker/digilocker.module";
import { DocumentStorageModule } from "./modules/document-storage/document-storage.module";
import { FieldTasksModule } from "./modules/field-tasks/field-tasks.module";
import { PlatformModule } from "./modules/platform/platform.module";
import { PortalAuthModule } from "./modules/portal-auth/portal-auth.module";
import { UsageModule } from "./modules/usage/usage.module";
import { VerificationModule } from "./modules/verifications/verification.module";
import { WorkerAuthModule } from "./modules/worker-auth/worker-auth.module";
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
    PortalAuthModule,
    VerificationModule,
    AadhaarOvseModule,
    DigiLockerModule,
    DocumentStorageModule,
    FieldTasksModule,
    PlatformModule,
    UsageModule,
    AdminModule,
  ],
  controllers: [HealthController],
  // Keyed on req.ip, which "trust proxy" in main.ts resolves to the real client. Keying on the
  // presented API key let anyone dodge the limit by sending random keys.
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
