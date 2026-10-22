import { BadRequestException, Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Query, UseGuards } from "@nestjs/common";
import { PrismaService } from "../../common/database/prisma.service";
import { AdminAccessGuard } from "../admin-access/admin-access.guard";
import { AdminContext, AuditAction, CurrentAdmin, RequirePermission, scopedTenantId } from "../admin-access/admin-context";
import { id, pageOf, paginated } from "../admin-panel/input";
import { CatalogService, packageCode } from "./catalog.service";
import { InvitesService } from "./invites.service";
import { CheckoutCustomer, OrdersService } from "./orders.service";
import { QuoteService } from "./quote.service";
import { SeatsService } from "./seats.service";
import { UsageBillingService } from "./usage-billing.service";
import { buyingPartner, partnerReturnUrl, period } from "./billing-http";

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
