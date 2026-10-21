import { Module } from "@nestjs/common";
import { DocumentStorageModule } from "../document-storage/document-storage.module";
import { UsageModule } from "../usage/usage.module";
import { VerificationModule } from "../verifications/verification.module";
import { CardLookupService } from "./card-lookup.service";
import { CardLookupController, CasesController, VerifiersController } from "./cases.controller";
import { CasesService } from "./cases.service";
import {
  AdminAuditLogsController,
  AdminUsageController,
  OrganisationController,
  PartnersController,
  PartnerUsersController,
  StaffController,
  VendorsController,
  VendorUsersController
} from "./management.controller";
import { PartnersService } from "./partners.service";
import { StaffDirectoryService } from "./staff-directory.service";

/** The admin panel API (/v1/admin/*). Every controller is guarded by AdminAccessGuard. */
@Module({
  imports: [DocumentStorageModule, UsageModule, VerificationModule],
  controllers: [
    PartnersController, VendorsController, StaffController, OrganisationController, PartnerUsersController, VendorUsersController,
    AdminAuditLogsController, AdminUsageController, CasesController, CardLookupController, VerifiersController
  ],
  providers: [PartnersService, StaffDirectoryService, CasesService, CardLookupService]
})
export class AdminPanelModule {}
