import { Module } from "@nestjs/common";
import { VerificationModule } from "../verifications/verification.module";
import { AadhaarMasker } from "./aadhaar-masker";
import { DocumentStorageController } from "./document-storage.controller";
import { DocumentStorageService } from "./document-storage.service";

@Module({
  imports: [VerificationModule],
  controllers: [DocumentStorageController],
  providers: [DocumentStorageService, AadhaarMasker],
  exports: [DocumentStorageService]
})
export class DocumentStorageModule {}
