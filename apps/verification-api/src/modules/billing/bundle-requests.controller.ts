import { BadRequestException, Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Query, UseGuards } from "@nestjs/common";
import { AdminAccessGuard } from "../admin-access/admin-access.guard";
import { AdminContext, AuditAction, CurrentAdmin, RecentSignIn, RequirePermission, scopedTenantId } from "../admin-access/admin-context";
import { BundlePriceInput, BundleRequestInput, BundleRequestsService } from "./bundle-requests.service";

/**
 * Custom bundles. Partners (billing.buy) ask for a price and accept or decline it; Keystone
 * (packages.manage) sees the cost, sets the price and seat limit. Costs never reach partner routes.
 */
@Controller("v1/admin")
@UseGuards(AdminAccessGuard)
export class BundleRequestsController {
  constructor(@Inject(BundleRequestsService) private readonly bundles: BundleRequestsService) {}

  // Partner (and Keystone acting for one)

  @Get("bundle-requests/checks")
  @RequirePermission("billing.buy", { allPartners: true })
  checks() {
    return this.bundles.requestableChecks();
  }

  @Get("bundle-requests")
  @RequirePermission("billing.buy", { allPartners: true })
  @AuditAction("bundles.list")
  list(@CurrentAdmin() admin: AdminContext, @Query("status") status?: string) {
    return this.bundles.list(admin, status);
  }

  @Get("bundle-requests/:requestId")
  @RequirePermission("billing.buy", { allPartners: true })
  @AuditAction("bundles.read", { resourceType: "BundleRequest", resourceParam: "requestId" })
  get(@CurrentAdmin() admin: AdminContext, @Param("requestId") requestId: string) {
    return this.bundles.get(admin, requestId);
  }

  @Post("bundle-requests")
  @RequirePermission("billing.buy")
  @AuditAction("bundles.request", { resourceType: "BundleRequest" })
  create(@CurrentAdmin() admin: AdminContext, @Body() body: BundleRequestInput) {
    const tenantId = scopedTenantId(admin);
    if (!tenantId) throw new BadRequestException("Choose a partner (x-partner-id) to ask for");
    return this.bundles.create(admin, tenantId, body ?? {});
  }

  @Post("bundle-requests/:requestId/accept")
  @HttpCode(200)
  @RequirePermission("billing.buy")
  @RecentSignIn()
  @AuditAction("bundles.accept", { resourceType: "BundleRequest", resourceParam: "requestId" })
  accept(@CurrentAdmin() admin: AdminContext, @Param("requestId") requestId: string) {
    return this.bundles.accept(admin, requestId);
  }

  @Post("bundle-requests/:requestId/decline")
  @HttpCode(200)
  @RequirePermission("billing.buy")
  @AuditAction("bundles.decline", { resourceType: "BundleRequest", resourceParam: "requestId" })
  decline(@CurrentAdmin() admin: AdminContext, @Param("requestId") requestId: string) {
    return this.bundles.decline(admin, requestId);
  }

  // Keystone

  @Get("bundle-requests/:requestId/evaluation")
  @RequirePermission("packages.manage")
  @AuditAction("bundles.evaluate", { resourceType: "BundleRequest", resourceParam: "requestId" })
  evaluation(@Param("requestId") requestId: string) {
    return this.bundles.evaluation(requestId);
  }

  @Post("bundle-requests/:requestId/price")
  @HttpCode(200)
  @RequirePermission("packages.manage")
  @RecentSignIn()
  @AuditAction("bundles.price", { resourceType: "BundleRequest", resourceParam: "requestId" })
  price(@CurrentAdmin() admin: AdminContext, @Param("requestId") requestId: string, @Body() body: BundlePriceInput) {
    return this.bundles.price(admin, requestId, body ?? {});
  }

  @Post("bundle-requests/:requestId/reject")
  @HttpCode(200)
  @RequirePermission("packages.manage")
  @AuditAction("bundles.reject", { resourceType: "BundleRequest", resourceParam: "requestId" })
  reject(@CurrentAdmin() admin: AdminContext, @Param("requestId") requestId: string, @Body() body: { note?: unknown }) {
    return this.bundles.reject(admin, requestId, body?.note);
  }

  @Get("check-costs")
  @RequirePermission("packages.manage")
  @AuditAction("checkcosts.list")
  listCosts() {
    return this.bundles.listCosts();
  }

  @Put("check-costs/:checkType")
  @RequirePermission("packages.manage")
  @RecentSignIn()
  @AuditAction("checkcosts.set", { resourceType: "CheckCost", resourceParam: "checkType" })
  setCost(@CurrentAdmin() admin: AdminContext, @Param("checkType") checkType: string, @Body() body: { unitCostPaise?: unknown; note?: unknown }) {
    return this.bundles.setCost(admin, checkType, body ?? {});
  }
}
