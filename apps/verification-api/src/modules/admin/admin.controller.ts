import { Body, Controller, Get, Inject, Param, Post, Query, UseGuards } from "@nestjs/common";
import { AdminGuard } from "../../common/auth/admin.guard";
import { AuditOutcome, AuditService } from "../../common/audit/audit.service";
import { UsageService } from "../usage/usage.service";
import { AdminService, CreatePartnerInput, IssueKeyInput } from "./admin.service";

/**
 * Operator-only provisioning + audit surface, guarded by X-Admin-Key.
 * Partners never touch these routes.
 */
@Controller("admin")
@UseGuards(AdminGuard)
export class AdminController {
  constructor(
    @Inject(AdminService) private readonly admin: AdminService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(UsageService) private readonly usage: UsageService
  ) {}

  // Partner-wise billable usage. e.g. GET /admin/usage?from=2026-09-01&to=2026-10-01
  @Get("usage")
  usageReport(
    @Query("from") from?: string,
    @Query("clientId") clientId?: string,
    @Query("tenantId") tenantId?: string,
    @Query("to") to?: string
  ) {
    const parseDate = (value?: string): Date | undefined => {
      if (!value) return undefined;
      const d = new Date(value);
      return Number.isNaN(d.getTime()) ? undefined : d;
    };
    return this.usage.getUsage({
      from: parseDate(from),
      to: parseDate(to),
      tenantId: tenantId || undefined,
      clientId: clientId || undefined,
    });
  }

  @Post("partners")
  createPartner(@Body() body: CreatePartnerInput) {
    return this.admin.createPartner(body);
  }

  @Get("partners")
  listPartners() {
    return this.admin.listPartners();
  }

  @Post("clients/:clientId/keys")
  issueKey(@Param("clientId") clientId: string, @Body() body: IssueKeyInput) {
    return this.admin.issueKey(clientId, body ?? {});
  }

  @Post("keys/:id/revoke")
  revokeKey(@Param("id") id: string) {
    return this.admin.revokeKey(id);
  }

  @Post("keys/:id/rotate")
  rotateKey(@Param("id") id: string) {
    return this.admin.rotateKey(id);
  }

  @Get("audit-logs")
  auditLogs(
    @Query("tenantId") tenantId?: string,
    @Query("clientId") clientId?: string,
    @Query("apiKeyId") apiKeyId?: string,
    @Query("action") action?: string,
    @Query("outcome") outcome?: string,
    @Query("limit") limit?: string
  ) {
    return this.audit
      .list({
        tenantId: tenantId || undefined,
        clientId: clientId || undefined,
        apiKeyId: apiKeyId || undefined,
        action: action || undefined,
        outcome: (outcome as AuditOutcome) || undefined,
        limit: limit ? Number(limit) : undefined,
      })
      .then((logs) => ({ logs }));
  }
}
