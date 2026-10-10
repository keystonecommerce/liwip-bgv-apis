import { Module } from "@nestjs/common";
import { AadhaarOvseModule } from "../aadhaar-ovse/aadhaar-ovse.module";
import { VerificationModule } from "../verifications/verification.module";
import { WorkerCaseController } from "./worker-case.controller";
import { WorkerCaseService } from "./worker-case.service";

@Module({
  imports: [VerificationModule, AadhaarOvseModule],
  controllers: [WorkerCaseController],
  providers: [WorkerCaseService]
})
export class WorkerCaseModule {}
