import { Module } from "@nestjs/common";
import { UsageQueue } from "./usage.queue";
import { UsageService } from "./usage.service";

/**
 * Metering plane: UsageQueue records billable events (used by the verification
 * worker); UsageService reads them for billing (used by the admin usage route).
 */
@Module({
  providers: [UsageQueue, UsageService],
  exports: [UsageQueue, UsageService],
})
export class UsageModule {}
