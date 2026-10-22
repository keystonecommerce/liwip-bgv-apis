import { Module } from "@nestjs/common";
import { UsageModule } from "../usage/usage.module";
import { VerificationModule } from "../verifications/verification.module";
import { FieldTasksController } from "./field-tasks.controller";
import { FieldTasksService } from "./field-tasks.service";

@Module({
  imports: [VerificationModule, UsageModule],
  controllers: [FieldTasksController],
  providers: [FieldTasksService]
})
export class FieldTasksModule {}
