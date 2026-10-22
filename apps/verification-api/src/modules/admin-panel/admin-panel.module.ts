import { Module } from "@nestjs/common";
import { DocumentStorageModule } from "../document-storage/document-storage.module";
import { UsageModule } from "../usage/usage.module";
import { VerificationModule } from "../verifications/verification.module";
import { ApiKeysController } from "./api-keys.controller";
import { ApiKeysService } from "./api-keys.service";
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
import { ReviewQueueController } from "./review-queue.controller";
import { ReviewQueueService } from "./review-queue.service";
import { StaffDirectoryService } from "./staff-directory.service";
import { SupportController } from "./support.controller";
import { ReportsModule } from "../reports/reports.module";
import { SupportService } from "./support.service";

/** The admin panel API (/v1/admin/*). Every controller is guarded by AdminAccessGuard. */
@Module({
  imports: [DocumentStorageModule, UsageModule, VerificationModule, ReportsModule],
  controllers: [
    PartnersController, VendorsController, StaffController, OrganisationController, PartnerUsersController, VendorUsersController,
    AdminAuditLogsController, AdminUsageController, CasesController, CardLookupController, VerifiersController,
    ApiKeysController, SupportController, ReviewQueueController
  ],
  providers: [PartnersService, StaffDirectoryService, CasesService, CardLookupService, ApiKeysService, SupportService, ReviewQueueService]
})
export class AdminPanelModule {}
