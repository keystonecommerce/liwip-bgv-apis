import { Body, Controller, HttpCode, Inject, Param, Post, UseGuards } from "@nestjs/common";
import { AdminAccessGuard } from "../admin-access/admin-access.guard";
import { AdminContext, AuditAction, CurrentAdmin, RecentSignIn, RequirePermission } from "../admin-access/admin-context";
import { id } from "./input";
import { SupportService } from "./support.service";

/** Keystone support tools. Looking a person up is the Verifications search (/v1/admin/cases?search=). */
@Controller("v1/admin/support")
@UseGuards(AdminAccessGuard)
export class SupportController {
  constructor(@Inject(SupportService) private readonly support: SupportService) {}

  /** Puts checks back to waiting so the person can submit them again; other progress stays. */
  @Post("cases/:caseId/reopen")
  @HttpCode(200)
  @RequirePermission("support.manage")
  @RecentSignIn()
  @AuditAction("support.checks.reopen", { resourceType: "Application", resourceParam: "caseId" })
  reopen(@Param("caseId") caseId: string, @Body() body: { types?: unknown }) {
    return this.support.reopenChecks(id(caseId, "caseId"), body ?? {});
  }

  /** A fresh start for one phone number: their cases are archived (not deleted) and passkeys removed. */
  @Post("people/reset")
  @HttpCode(200)
  @RequirePermission("support.manage")
  @RecentSignIn()
  @AuditAction("support.person.reset")
  reset(@CurrentAdmin() admin: AdminContext, @Body() body: { phone?: string; programId?: string }) {
    admin.audit = { resourceType: "Application", metadata: { phoneLast4: String(body?.phone ?? "").slice(-4) } };
    return this.support.resetPerson({ phone: body?.phone, clientId: body?.programId });
  }

  /** Test environments only (ADMIN_PURGE_ENABLED=true): deletes every person's data. */
  @Post("purge")
  @HttpCode(200)
  @RequirePermission("support.manage")
  @RecentSignIn()
  @AuditAction("support.purge")
  purge(@Body() body: { confirm?: string }) {
    return this.support.purgeWorkerData(body ?? {});
  }
}
