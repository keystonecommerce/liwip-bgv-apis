import { Module } from "@nestjs/common";
import { DatabaseModule } from "../../common/database/database.module";
import { PortalAuthController } from "./portal-auth.controller";
import { PortalAuthService } from "./portal-auth.service";
import { PortalAuthGuard } from "./portal-context";

@Module({
  imports: [DatabaseModule],
  controllers: [PortalAuthController],
  providers: [PortalAuthService, PortalAuthGuard],
  exports: [PortalAuthService, PortalAuthGuard]
})
export class PortalAuthModule {}
