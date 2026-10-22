import { Module } from "@nestjs/common";
import { VerificationModule } from "../verifications/verification.module";
import { ReportsModule } from "../reports/reports.module";
import { PlatformController } from "./platform.controller";

@Module({ imports: [VerificationModule, ReportsModule], controllers: [PlatformController] })
export class PlatformModule {}
