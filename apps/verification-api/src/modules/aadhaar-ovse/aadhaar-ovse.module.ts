import { Module } from "@nestjs/common";
import { VerificationModule } from "../verifications/verification.module";
import { AadhaarOvseController } from "./aadhaar-ovse.controller";
import { AadhaarOvseService } from "./aadhaar-ovse.service";

@Module({
  imports: [VerificationModule],
  controllers: [AadhaarOvseController],
  providers: [AadhaarOvseService]
})
export class AadhaarOvseModule {}
