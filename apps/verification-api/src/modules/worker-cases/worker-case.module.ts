import { Module } from "@nestjs/common";
import { AadhaarOvseModule } from "../aadhaar-ovse/aadhaar-ovse.module";
import { DocumentExtractor } from "../../integrations/bedrock/document-extractor";
import { DigiLockerModule } from "../digilocker/digilocker.module";
import { VerificationModule } from "../verifications/verification.module";
import { WorkerCaseController } from "./worker-case.controller";
import { DigiLockerDocumentReader } from "./digilocker/document-reader.service";
import { WorkerCaseService } from "./worker-case.service";

@Module({
  imports: [VerificationModule, AadhaarOvseModule, DigiLockerModule],
  controllers: [WorkerCaseController],
  providers: [WorkerCaseService, DigiLockerDocumentReader, DocumentExtractor]
})
export class WorkerCaseModule {}
