import { Module } from "@nestjs/common";
import { AdminGuard } from "../../common/auth/admin.guard";
import { UsageModule } from "../usage/usage.module";
import { AdminController } from "./admin.controller";
import { AdminService } from "./admin.service";

@Module({
  imports: [UsageModule],
  controllers: [AdminController],
  providers: [AdminService, AdminGuard],
})
export class AdminModule {}
