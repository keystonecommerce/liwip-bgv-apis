import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Put, Query, UseGuards } from "@nestjs/common";
import { AdminAccessGuard } from "../admin-access/admin-access.guard";
import { AdminContext, AuditAction, CurrentAdmin, RequirePermission, RecentSignIn } from "../admin-access/admin-context";
import { id, text } from "../admin-panel/input";
import { periodOf, periodRange } from "./billing-config";
import { CatalogService, DiscountRuleInput, PackageInput, packageCode, PartnerPriceInput } from "./catalog.service";
import { CheckRateInput, CheckRatesService } from "./check-rates.service";
import { OrdersService } from "./orders.service";
import { RevenueService } from "./revenue.service";
import { SeatsService } from "./seats.service";
import { UsageBillingService } from "./usage-billing.service";
import { istDay, period } from "./billing-http";

/** Keystone: packages, add-ons, discount tiers, partner prices, seat adjustments and refunds. */
@Controller("v1/admin")
@UseGuards(AdminAccessGuard)
export class BillingAdminController {
  constructor(
    @Inject(CatalogService) private readonly catalog: CatalogService,
    @Inject(SeatsService) private readonly seats: SeatsService,
    @Inject(OrdersService) private readonly orders: OrdersService,
    @Inject(CheckRatesService) private readonly checkRates: CheckRatesService,
    @Inject(UsageBillingService) private readonly usage: UsageBillingService,
    @Inject(RevenueService) private readonly revenue: RevenueService
  ) {}

  @Get("check-rates")
  @RequirePermission("pricing.manage")
  @AuditAction("check-rates.list")
  listCheckRates(@Query("partnerId") partnerId?: string, @Query("scope") scope?: string) {
    return this.checkRates.list(partnerId ? id(partnerId, "partnerId") : scope === "list" ? null : undefined);
  }

  @Post("check-rates")
  @RequirePermission("pricing.manage")
  @RecentSignIn()
  @AuditAction("check-rates.create", { resourceType: "CheckRate" })
  createCheckRate(@CurrentAdmin() admin: AdminContext, @Body() body: CheckRateInput) {
    return this.checkRates.create(admin, body ?? {});
  }

  @Patch("check-rates/:rateId")
  @RequirePermission("pricing.manage")
  @RecentSignIn()
  @AuditAction("check-rates.update", { resourceType: "CheckRate", resourceParam: "rateId" })
  updateCheckRate(@CurrentAdmin() admin: AdminContext, @Param("rateId") rateId: string, @Body() body: CheckRateInput) {
    return this.checkRates.update(admin, rateId, body ?? {});
  }

  /** Sales in India-time days, `to` inclusive. Default: this month so far. */
  @Get("revenue")
  @RequirePermission("revenue.read")
  @AuditAction("revenue.read")
  report(@Query() query: { from?: string; to?: string; partnerId?: string }) {
    const from = istDay(query.from, "from") ?? periodRange(periodOf(new Date())).from;
    const toDay = istDay(query.to, "to");
    const to = toDay ? new Date(toDay.getTime() + 86_400_000) : new Date();
    return this.revenue.report({ from, to, tenantId: query.partnerId ? id(query.partnerId, "partnerId") : undefined });
  }

  @Post("usage-charges/rate")
  @HttpCode(200)
  @RequirePermission("statements.manage")
  @AuditAction("usage.rate")
  rateUsage() {
    return this.usage.rate();
  }

  @Post("statements/issue")
  @HttpCode(200)
  @RequirePermission("statements.manage")
  @RecentSignIn()
  @AuditAction("statements.issue", { resourceType: "UsageStatement" })
  async issueStatements(@CurrentAdmin() admin: AdminContext, @Body() body: { period?: string; partnerId?: string }) {
    await this.usage.rate();
    return this.usage.issueStatements({ period: period(body?.period), tenantId: body?.partnerId ? id(body.partnerId, "partnerId") : undefined, createdById: admin.user.id });
  }

  @Post("statements/:statementId/paid")
  @HttpCode(200)
  @RequirePermission("statements.manage")
  @RecentSignIn()
  @AuditAction("statements.paid", { resourceType: "UsageStatement", resourceParam: "statementId" })
  statementPaid(@Param("statementId") statementId: string, @Body() body: { reference?: string; paidOn?: string }) {
    return this.usage.markPaid({ statementId: id(statementId, "statementId"), reference: String(body?.reference ?? ""), paidAt: istDay(body?.paidOn, "paidOn") ?? null });
  }

  @Get("packages")
  @RequirePermission("packages.manage")
  @AuditAction("packages.list")
  listPackages() {
    return this.catalog.listPackages();
  }

  @Post("packages")
  @RequirePermission("packages.manage")
  @AuditAction("packages.create", { resourceType: "VerificationPackage" })
  createPackage(@CurrentAdmin() admin: AdminContext, @Body() body: PackageInput) {
    return this.catalog.createPackage(admin, body ?? {});
  }

  @Put("packages/:code/draft")
  @RequirePermission("packages.manage")
  @AuditAction("packages.draft", { resourceType: "VerificationPackage" })
  saveDraft(@CurrentAdmin() admin: AdminContext, @Param("code") code: string, @Body() body: PackageInput) {
    return this.catalog.saveDraft(admin, code, body ?? {});
  }

  @Post("packages/:code/publish")
  @HttpCode(200)
  @RequirePermission("packages.manage")
  @RecentSignIn()
  @AuditAction("packages.publish", { resourceType: "VerificationPackage" })
  publish(@CurrentAdmin() admin: AdminContext, @Param("code") code: string) {
    return this.catalog.publish(admin, code);
  }

  @Post("packages/:code/retire")
  @HttpCode(200)
  @RequirePermission("packages.manage")
  @RecentSignIn()
  @AuditAction("packages.retire", { resourceType: "VerificationPackage" })
  retire(@CurrentAdmin() admin: AdminContext, @Param("code") code: string) {
    return this.catalog.retire(admin, code);
  }

  @Put("packages/:code/add-ons")
  @RequirePermission("packages.manage")
  @AuditAction("packages.addons", { resourceType: "PackageAddOn" })
  setAddOns(@CurrentAdmin() admin: AdminContext, @Param("code") code: string, @Body() body: { addOnChecks?: unknown }) {
    return this.catalog.setAddOns(admin, code, body?.addOnChecks);
  }

  @Get("discount-rules")
  @RequirePermission("pricing.manage")
  @AuditAction("discounts.list")
  listDiscountRules(@Query("partnerId") partnerId?: string) {
    return this.catalog.listDiscountRules(partnerId ? id(partnerId, "partnerId") : undefined);
  }

  @Post("discount-rules")
  @RequirePermission("pricing.manage")
  @RecentSignIn()
  @AuditAction("discounts.create", { resourceType: "DiscountRule" })
  createDiscountRule(@CurrentAdmin() admin: AdminContext, @Body() body: DiscountRuleInput) {
    return this.catalog.createDiscountRule(admin, body ?? {});
  }

  @Patch("discount-rules/:ruleId")
  @RequirePermission("pricing.manage")
  @RecentSignIn()
  @AuditAction("discounts.update", { resourceType: "DiscountRule", resourceParam: "ruleId" })
  updateDiscountRule(@CurrentAdmin() admin: AdminContext, @Param("ruleId") ruleId: string, @Body() body: DiscountRuleInput) {
    return this.catalog.updateDiscountRule(admin, ruleId, body ?? {});
  }

  @Get("partners/:partnerId/prices")
  @RequirePermission("pricing.manage")
  @AuditAction("partner-prices.list", { resourceType: "Tenant", resourceParam: "partnerId" })
  listPartnerPrices(@Param("partnerId") partnerId: string) {
    return this.catalog.listPartnerPrices(id(partnerId, "partnerId"));
  }

  @Post("partners/:partnerId/prices")
  @RequirePermission("pricing.manage")
  @RecentSignIn()
  @AuditAction("partner-prices.create", { resourceType: "PartnerPrice" })
  createPartnerPrice(@CurrentAdmin() admin: AdminContext, @Param("partnerId") partnerId: string, @Body() body: PartnerPriceInput) {
    return this.catalog.createPartnerPrice(admin, partnerId, body ?? {});
  }

  @Patch("partners/:partnerId/prices/:priceId")
  @RequirePermission("pricing.manage")
  @RecentSignIn()
  @AuditAction("partner-prices.update", { resourceType: "PartnerPrice", resourceParam: "priceId" })
  updatePartnerPrice(@CurrentAdmin() admin: AdminContext, @Param("partnerId") partnerId: string, @Param("priceId") priceId: string, @Body() body: PartnerPriceInput) {
    return this.catalog.updatePartnerPrice(admin, partnerId, priceId, body ?? {});
  }

  @Post("partners/:partnerId/seats/adjust")
  @HttpCode(200)
  @RequirePermission("seats.adjust")
  @RecentSignIn()
  @AuditAction("seats.adjust", { resourceType: "Tenant", resourceParam: "partnerId" })
  async adjustSeats(@CurrentAdmin() admin: AdminContext, @Param("partnerId") partnerId: string, @Body() body: { packageCode?: string; delta?: number; reason?: string }) {
    const tenantId = id(partnerId, "partnerId");
    admin.audit = { tenantId, resourceType: "SeatLedger", metadata: { packageCode: body?.packageCode, delta: body?.delta } };
    return this.seats.adjust({ tenantId, packageCode: packageCode(body?.packageCode), delta: body?.delta as number, reason: text(body?.reason, "reason", 300, 5), createdById: admin.user.id });
  }

  @Post("orders/:orderId/refunds")
  @HttpCode(200)
  @RequirePermission("orders.refund")
  @RecentSignIn()
  @AuditAction("orders.refund", { resourceType: "Order", resourceParam: "orderId" })
  refund(@CurrentAdmin() admin: AdminContext, @Param("orderId") orderId: string, @Body() body: { amountPaise?: number; reason?: string; seats?: Record<string, number>; allowUsedSeats?: boolean }) {
    return this.orders.refund({ orderId: id(orderId, "orderId"), amountPaise: body?.amountPaise as number, reason: text(body?.reason, "reason", 300, 5), seats: body?.seats, allowUsedSeats: body?.allowUsedSeats === true, createdById: admin.user.id });
  }
}
