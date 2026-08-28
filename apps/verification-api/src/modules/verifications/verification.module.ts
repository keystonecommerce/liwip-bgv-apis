import { Module } from "@nestjs/common";
import { SurepassProvider } from "../../integrations/surepass/surepass.provider";
import { VerificationController } from "./verification.controller";
import { VerificationQueue } from "./verification.queue";
import { VerificationStore } from "./verification.repository";
import { VerificationService } from "./verification.service";
import { WorkerApplicationController } from "./worker-application.controller";

@Module({
  controllers: [VerificationController, WorkerApplicationController],
  providers: [VerificationStore, SurepassProvider, VerificationQueue, VerificationService],
  exports: [VerificationService, SurepassProvider]
})
export class VerificationModule {}
