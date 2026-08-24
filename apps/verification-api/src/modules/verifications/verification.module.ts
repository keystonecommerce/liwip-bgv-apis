import { Module } from "@nestjs/common";
import { SurepassProvider } from "../../integrations/surepass/surepass.provider";
import { VerificationController } from "./verification.controller";
import { VerificationQueue } from "./verification.queue";
import { VerificationStore } from "./verification.repository";
import { VerificationService } from "./verification.service";

@Module({
  controllers: [VerificationController],
  providers: [VerificationStore, SurepassProvider, VerificationQueue, VerificationService],
  exports: [VerificationService]
})
export class VerificationModule {}
