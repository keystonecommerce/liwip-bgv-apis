import { Module } from "@nestjs/common";
import { SurepassProvider } from "../../integrations/surepass/surepass.provider";
import { UsageModule } from "../usage/usage.module";
import { VerificationController } from "./verification.controller";
import { VerificationQueue } from "./verification.queue";
import { VerificationStore } from "./verification.repository";
import { VerificationService } from "./verification.service";
import { WorkerApplicationController } from "./worker-application.controller";
import { VERIFICATION_PROVIDER } from "../../integrations/verification-provider";
import { SurepassTransport } from "../../integrations/surepass/surepass.transport";
import { SupplementaryCheckController } from "./supplementary-check.controller";
import { SupplementaryCheckService } from "./supplementary-check.service";

@Module({
  imports: [UsageModule],
  controllers: [VerificationController, WorkerApplicationController, SupplementaryCheckController],
  providers: [VerificationStore, SurepassTransport, SurepassProvider,
    { provide: VERIFICATION_PROVIDER, useFactory: (provider: SurepassProvider) => {
      const selected = process.env.VERIFICATION_PROVIDER || "surepass";
      if (selected !== "surepass") throw new Error(`Unsupported VERIFICATION_PROVIDER: ${selected}`);
      return provider;
    }, inject: [SurepassProvider] },
    VerificationQueue, VerificationService, SupplementaryCheckService],
  exports: [VerificationService, VERIFICATION_PROVIDER, SurepassProvider, SurepassTransport, VerificationStore, VerificationQueue]
})
export class VerificationModule {}
