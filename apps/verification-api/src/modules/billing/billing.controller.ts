import { BadRequestException, Body, Controller, Get, Headers, HttpCode, Inject, Param, Patch, Post, Put, Query, Req, Res, UseGuards } from "@nestjs/common";
import type { Request, Response } from "express";
import { ApiKeyGuard } from "../../common/auth/api-key.guard";
import { ClientContext, CurrentClient } from "../../common/auth/client-context";
import { ScopeGuard } from "../../common/auth/scope.guard";
import { RequireScopes } from "../../common/auth/scopes";
import { CurrentWorker, WorkerGuard } from "../../common/auth/worker.guard";
import type { WorkerIdentity } from "../../common/auth/worker-token";
import { PrismaService } from "../../common/database/prisma.service";
import { AdminAccessGuard } from "../admin-access/admin-access.guard";
import { AdminContext, AuditAction, CurrentAdmin, RequirePermission, scopedTenantId } from "../admin-access/admin-context";
import { id, pageOf, paginated, text } from "../admin-panel/input";
import { billingConfig, periodOf, periodRange } from "./billing-config";
import { CatalogService, DiscountRuleInput, PackageInput, packageCode, PartnerPriceInput } from "./catalog.service";
import { CheckRateInput, CheckRatesService } from "./check-rates.service";
import { InvitesService } from "./invites.service";
import { CheckoutCustomer, OrdersService } from "./orders.service";
import { QuoteService } from "./quote.service";
import { RevenueService } from "./revenue.service";
import { SeatsService } from "./seats.service";
import { UsageBillingService } from "./usage-billing.service";

/** The partner a buying request acts for. Keystone staff pick one with x-partner-id. */
function buyingPartner(admin: AdminContext): string {
  const tenantId = scopedTenantId(admin);
  if (!tenantId) throw new BadRequestException("Choose a partner (x-partner-id) to buy for");
  return tenantId;
}

const IST_MS = 330 * 60_000;
/** A YYYY-MM-DD day in India time, as the instant it starts. */
function istDay(value: string | undefined, label: string): Date | undefined {
  if (value === undefined || value === "") return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new BadRequestException(`${label} must be YYYY-MM-DD`);
  const date = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new BadRequestException(`${label} is not a date`);
  return new Date(date.getTime() - IST_MS);
}

function period(value: unknown): string {
  const text = String(value ?? "");
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(text)) throw new BadRequestException("period must look like 2026-10");
  return text;
}

const partnerReturnUrl = () => process.env.BILLING_PARTNER_RETURN_URL || `${(process.env.ADMIN_PANEL_URL || "http://localhost:5173").replace(/\/+$/, "")}/billing/orders/{order_id}`;

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
  @AuditAction("check-rates.create", { resourceType: "CheckRate" })
  createCheckRate(@CurrentAdmin() admin: AdminContext, @Body() body: CheckRateInput) {
    return this.checkRates.create(admin, body ?? {});
  }

  @Patch("check-rates/:rateId")
  @RequirePermission("pricing.manage")
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
  @AuditAction("statements.issue", { resourceType: "UsageStatement" })
  async issueStatements(@CurrentAdmin() admin: AdminContext, @Body() body: { period?: string; partnerId?: string }) {
    await this.usage.rate();
    return this.usage.issueStatements({ period: period(body?.period), tenantId: body?.partnerId ? id(body.partnerId, "partnerId") : undefined, createdById: admin.user.id });
  }

  @Post("statements/:statementId/paid")
  @HttpCode(200)
  @RequirePermission("statements.manage")
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
  @AuditAction("packages.publish", { resourceType: "VerificationPackage" })
  publish(@CurrentAdmin() admin: AdminContext, @Param("code") code: string) {
    return this.catalog.publish(admin, code);
  }

  @Post("packages/:code/retire")
  @HttpCode(200)
  @RequirePermission("packages.manage")
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
  @AuditAction("discounts.create", { resourceType: "DiscountRule" })
  createDiscountRule(@CurrentAdmin() admin: AdminContext, @Body() body: DiscountRuleInput) {
    return this.catalog.createDiscountRule(admin, body ?? {});
  }

  @Patch("discount-rules/:ruleId")
  @RequirePermission("pricing.manage")
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
  @AuditAction("partner-prices.create", { resourceType: "PartnerPrice" })
  createPartnerPrice(@CurrentAdmin() admin: AdminContext, @Param("partnerId") partnerId: string, @Body() body: PartnerPriceInput) {
    return this.catalog.createPartnerPrice(admin, partnerId, body ?? {});
  }

  @Patch("partners/:partnerId/prices/:priceId")
  @RequirePermission("pricing.manage")
  @AuditAction("partner-prices.update", { resourceType: "PartnerPrice", resourceParam: "priceId" })
  updatePartnerPrice(@CurrentAdmin() admin: AdminContext, @Param("partnerId") partnerId: string, @Param("priceId") priceId: string, @Body() body: PartnerPriceInput) {
    return this.catalog.updatePartnerPrice(admin, partnerId, priceId, body ?? {});
  }

  @Post("partners/:partnerId/seats/adjust")
  @HttpCode(200)
  @RequirePermission("seats.adjust")
  @AuditAction("seats.adjust", { resourceType: "Tenant", resourceParam: "partnerId" })
  async adjustSeats(@CurrentAdmin() admin: AdminContext, @Param("partnerId") partnerId: string, @Body() body: { packageCode?: string; delta?: number; reason?: string }) {
    const tenantId = id(partnerId, "partnerId");
    admin.audit = { tenantId, resourceType: "SeatLedger", metadata: { packageCode: body?.packageCode, delta: body?.delta } };
    return this.seats.adjust({ tenantId, packageCode: packageCode(body?.packageCode), delta: body?.delta as number, reason: text(body?.reason, "reason", 300, 5), createdById: admin.user.id });
  }

  @Post("orders/:orderId/refunds")
  @HttpCode(200)
  @RequirePermission("orders.refund")
  @AuditAction("orders.refund", { resourceType: "Order", resourceParam: "orderId" })
  refund(@CurrentAdmin() admin: AdminContext, @Param("orderId") orderId: string, @Body() body: { amountPaise?: number; reason?: string; seats?: Record<string, number>; allowUsedSeats?: boolean }) {
    return this.orders.refund({ orderId: id(orderId, "orderId"), amountPaise: body?.amountPaise as number, reason: text(body?.reason, "reason", 300, 5), seats: body?.seats, allowUsedSeats: body?.allowUsedSeats === true, createdById: admin.user.id });
  }
}

/** Partner staff (and Keystone acting for one partner): prices, quotes, orders, seats, uploads and invites. */
@Controller("v1/admin")
@UseGuards(AdminAccessGuard)
export class BillingPartnerController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CatalogService) private readonly catalog: CatalogService,
    @Inject(QuoteService) private readonly quotes: QuoteService,
    @Inject(OrdersService) private readonly orders: OrdersService,
    @Inject(SeatsService) private readonly seats: SeatsService,
    @Inject(InvitesService) private readonly invites: InvitesService,
    @Inject(UsageBillingService) private readonly usage: UsageBillingService
  ) {}

  @Get("statements")
  @RequirePermission("orders.read", { allPartners: true })
  @AuditAction("statements.list")
  async listStatements(@CurrentAdmin() admin: AdminContext, @Query() query: { status?: string; period?: string; page?: string; limit?: string }) {
    const tenantId = scopedTenantId(admin);
    const page = pageOf(query);
    const { rows, total } = await this.usage.list({ ...(tenantId ? { tenantId } : {}), status: query.status ? String(query.status).toUpperCase() : undefined, period: query.period ? period(query.period) : undefined }, page);
    return paginated(rows, total, page);
  }

  @Get("statements/:statementId")
  @RequirePermission("orders.read", { allPartners: true })
  @AuditAction("statements.read", { resourceType: "UsageStatement", resourceParam: "statementId" })
  statement(@CurrentAdmin() admin: AdminContext, @Param("statementId") statementId: string) {
    return this.usage.get(id(statementId, "statementId"), scopedTenantId(admin) ?? undefined);
  }

  @Get("catalog")
  @RequirePermission("billing.buy")
  @AuditAction("catalog.read")
  catalogue(@CurrentAdmin() admin: AdminContext) {
    return this.catalog.catalogFor(buyingPartner(admin));
  }

  @Post("quotes")
  @RequirePermission("billing.buy")
  @AuditAction("quotes.create", { resourceType: "Quote" })
  quote(@CurrentAdmin() admin: AdminContext, @Body() body: { lines?: unknown }) {
    const tenantId = buyingPartner(admin);
    admin.audit = { tenantId, resourceType: "Quote" };
    return this.quotes.create({ type: "PARTNER", tenantId, createdById: admin.user.id }, body?.lines);
  }

  @Post("orders")
  @HttpCode(200)
  @RequirePermission("billing.buy")
  @AuditAction("orders.checkout", { resourceType: "Order" })
  async checkout(@CurrentAdmin() admin: AdminContext, @Body() body: { quoteId?: string }, @Headers("idempotency-key") key?: string) {
    const tenantId = buyingPartner(admin);
    const tenant = await this.prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { id: true, name: true, legalName: true, contacts: true } });
    const contact = (Array.isArray(tenant.contacts) ? tenant.contacts : []).map((item) => item as { name?: string; email?: string; phone?: string }).find((item) => item?.phone);
    const phone = String(contact?.phone ?? "").replace(/\D/g, "").slice(-10);
    if (!/^[6-9]\d{9}$/.test(phone)) throw new BadRequestException("Add a contact mobile number to the company profile before paying");
    const customer: CheckoutCustomer = { id: tenant.id, phone, name: (tenant.legalName || tenant.name).slice(0, 100), email: contact?.email };
    admin.audit = { tenantId, resourceType: "Order" };
    return this.orders.checkout({ type: "PARTNER", tenantId, createdById: admin.user.id }, body?.quoteId, key, customer, partnerReturnUrl());
  }

  @Get("orders")
  @RequirePermission("orders.read", { allPartners: true })
  @AuditAction("orders.list")
  async listOrders(@CurrentAdmin() admin: AdminContext, @Query() query: { status?: string; page?: string; limit?: string }) {
    const tenantId = scopedTenantId(admin);
    const page = pageOf(query);
    const { rows, total } = await this.orders.list({ ...(tenantId ? { tenantId } : {}), ...(query.status ? { status: String(query.status).toUpperCase() } : {}) }, page);
    return paginated(rows, total, page);
  }

  @Get("orders/:orderId")
  @RequirePermission("orders.read", { allPartners: true })
  @AuditAction("orders.read", { resourceType: "Order", resourceParam: "orderId" })
  order(@CurrentAdmin() admin: AdminContext, @Param("orderId") orderId: string) {
    const tenantId = scopedTenantId(admin);
    return this.orders.get(String(orderId), tenantId ? { tenantId } : {});
  }

  @Get("seats")
  @RequirePermission("people.invite")
  @AuditAction("seats.read")
  async seatBalances(@CurrentAdmin() admin: AdminContext) {
    return { items: await this.seats.balances(buyingPartner(admin)) };
  }

  @Post("bulk-uploads")
  @RequirePermission("people.invite")
  @AuditAction("uploads.validate", { resourceType: "BulkUpload" })
  validateUpload(@CurrentAdmin() admin: AdminContext, @Body() body: { programId?: string; packageCode?: string; fileName?: string; csv?: unknown; rows?: unknown }) {
    const tenantId = buyingPartner(admin);
    admin.audit = { tenantId, resourceType: "BulkUpload", metadata: { packageCode: body?.packageCode } };
    return this.invites.validate({ tenantId, clientId: id(body?.programId, "programId"), packageCode: String(body?.packageCode ?? ""), fileName: String(body?.fileName ?? ""), csv: body?.csv, rows: body?.rows, createdById: admin.user.id });
  }

  @Get("bulk-uploads/:uploadId")
  @RequirePermission("people.invite")
  @AuditAction("uploads.read", { resourceType: "BulkUpload", resourceParam: "uploadId" })
  upload(@CurrentAdmin() admin: AdminContext, @Param("uploadId") uploadId: string) {
    return this.invites.getUpload(buyingPartner(admin), id(uploadId, "uploadId"));
  }

  @Post("bulk-uploads/:uploadId/send")
  @HttpCode(200)
  @RequirePermission("people.invite")
  @AuditAction("invites.send", { resourceType: "BulkUpload", resourceParam: "uploadId" })
  async send(@CurrentAdmin() admin: AdminContext, @Param("uploadId") uploadId: string) {
    const tenantId = buyingPartner(admin);
    const tenant = await this.prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { name: true } });
    return this.invites.send({ tenantId, uploadId: id(uploadId, "uploadId"), partnerName: tenant.name, createdById: admin.user.id });
  }

  @Get("invites")
  @RequirePermission("people.invite")
  @AuditAction("invites.list")
  async listInvites(@CurrentAdmin() admin: AdminContext, @Query() query: { status?: string; search?: string; uploadId?: string; page?: string; limit?: string }) {
    const page = pageOf(query);
    const { rows, total } = await this.invites.list(buyingPartner(admin), query, page);
    return paginated(rows, total, page);
  }

  @Post("invites/:inviteId/cancel")
  @HttpCode(200)
  @RequirePermission("people.invite")
  @AuditAction("invites.cancel", { resourceType: "Invite", resourceParam: "inviteId" })
  cancel(@CurrentAdmin() admin: AdminContext, @Param("inviteId") inviteId: string) {
    return this.invites.cancel({ tenantId: buyingPartner(admin), inviteId: id(inviteId, "inviteId") });
  }

  @Post("invites/:inviteId/resend")
  @HttpCode(200)
  @RequirePermission("people.invite")
  @AuditAction("invites.resend", { resourceType: "Invite", resourceParam: "inviteId" })
  async resend(@CurrentAdmin() admin: AdminContext, @Param("inviteId") inviteId: string) {
    const tenantId = buyingPartner(admin);
    const tenant = await this.prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { name: true } });
    return this.invites.resend({ tenantId, inviteId: id(inviteId, "inviteId"), partnerName: tenant.name });
  }
}

/** The Liwip app: an individual buys their own package. Same protection as their case. */
@Controller("v1/worker/billing")
@UseGuards(ApiKeyGuard, ScopeGuard, WorkerGuard)
@RequireScopes("worker:cases")
export class WorkerBillingController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CatalogService) private readonly catalog: CatalogService,
    @Inject(QuoteService) private readonly quotes: QuoteService,
    @Inject(OrdersService) private readonly orders: OrdersService
  ) {}

  private async workerCase(worker: WorkerIdentity) {
    const application = await this.prisma.application.findFirst({ where: { tenantId: worker.tenantId, clientId: worker.clientId, workerPhone: worker.phone }, select: { id: true, data: true } });
    if (!application) throw new BadRequestException("Open your case first");
    return application;
  }

  @Get("catalog")
  catalogue() {
    return this.catalog.catalogFor(null);
  }

  @Post("quotes")
  async quote(@CurrentWorker() worker: WorkerIdentity, @Body() body: { packageCode?: string; addOns?: string[] }) {
    const application = await this.workerCase(worker);
    return this.quotes.create({ type: "INDIVIDUAL", tenantId: worker.tenantId, clientId: worker.clientId, applicationId: application.id }, [{ packageCode: body?.packageCode, quantity: 1, addOns: body?.addOns }]);
  }

  @Post("orders")
  @HttpCode(200)
  async checkout(@CurrentWorker() worker: WorkerIdentity, @CurrentClient() _client: ClientContext, @Body() body: { quoteId?: string }, @Headers("idempotency-key") key?: string) {
    const application = await this.workerCase(worker);
    const name = String((application.data as { personal?: { nameAsAadhaar?: string } })?.personal?.nameAsAadhaar ?? "").slice(0, 100) || undefined;
    return this.orders.checkout(
      { type: "INDIVIDUAL", tenantId: worker.tenantId, clientId: worker.clientId, applicationId: application.id },
      body?.quoteId, key, { id: application.id, phone: worker.phone.slice(2), name }, `${billingConfig().workerAppUrl}/?order={order_id}`
    );
  }

  @Get("orders/:orderId")
  async order(@CurrentWorker() worker: WorkerIdentity, @Param("orderId") orderId: string) {
    const application = await this.workerCase(worker);
    return this.orders.get(String(orderId), { tenantId: worker.tenantId, clientId: worker.clientId, applicationId: application.id });
  }
}

/** Public: Cashfree's webhook (signature checked against the raw body) and invite links. */
@Controller()
export class BillingPublicController {
  constructor(@Inject(OrdersService) private readonly orders: OrdersService, @Inject(InvitesService) private readonly invites: InvitesService) {}

  @Post("v1/payments/cashfree/webhook")
  @HttpCode(200)
  webhook(@Req() request: Request & { rawBody?: Buffer }) {
    return this.orders.handleWebhook(request.rawBody, request.headers);
  }

  @Get("v/:token")
  async invite(@Param("token") token: string, @Res() response: Response) {
    response.redirect(302, await this.invites.landing(String(token)));
  }
}
