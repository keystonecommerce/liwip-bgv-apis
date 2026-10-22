import { Module } from "@nestjs/common";
import { VerificationModule } from "../verifications/verification.module";
import { ReportService } from "./report.service";

@Module({
  imports: [VerificationModule],
  providers: [ReportService],
  exports: [ReportService]
})
export class ReportsModule {}
