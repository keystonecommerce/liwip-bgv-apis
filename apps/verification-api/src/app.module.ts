import { Module } from "@nestjs/common";
import { AuthModule } from "./common/auth/auth.module";
import { DatabaseModule } from "./common/database/database.module";
import { PlatformModule } from "./modules/platform/platform.module";
import { VerificationModule } from "./modules/verifications/verification.module";

@Module({ imports: [DatabaseModule, AuthModule, VerificationModule, PlatformModule] })
export class AppModule {}
