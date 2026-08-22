import { Module } from "@nestjs/common";
import { VerificationController } from "./controller";
import { ProviderFactory } from "./provider";
import { VerificationQueue } from "./queue";
import { VerificationService } from "./service";
import { VerificationStore } from "./store";

@Module({
  controllers: [VerificationController],
  providers: [VerificationStore, ProviderFactory, VerificationQueue, VerificationService]
})
export class VerificationModule {}
