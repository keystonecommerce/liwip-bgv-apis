import { Module } from "@nestjs/common";
import { AuthModule } from "./common/auth/auth.module";
import { DatabaseModule } from "./common/database/database.module";
import { AadhaarOvseModule } from "./modules/aadhaar-ovse/aadhaar-ovse.module";
import { DigiLockerModule } from "./modules/digilocker/digilocker.module";
import { DocumentStorageModule } from "./modules/document-storage/document-storage.module";
import { PlatformModule } from "./modules/platform/platform.module";
import { VerificationModule } from "./modules/verifications/verification.module";
import { WorkerAuthModule } from "./modules/worker-auth/worker-auth.module";
import { HealthController } from "./common/health.controller";

@Module({
  imports: [DatabaseModule, AuthModule, WorkerAuthModule, VerificationModule, AadhaarOvseModule, DigiLockerModule, DocumentStorageModule, PlatformModule],
  controllers: [HealthController]
})
export class AppModule {}
