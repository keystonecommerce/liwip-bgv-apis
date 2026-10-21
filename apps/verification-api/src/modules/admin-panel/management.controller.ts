import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Put, Query, UseGuards } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../common/database/prisma.service";
import { AdminAccessGuard } from "../admin-access/admin-access.guard";
import { AdminContext, AuditAction, CurrentAdmin, partnerDb, RequirePermission } from "../admin-access/admin-context";
import { SYSTEM_ROLES } from "../admin-access/admin-permissions";
import { parseUsageDate, UsageService } from "../usage/usage.service";
import { id, oneOf, optionalDate, pageOf } from "./input";
import { PartnerInput, PartnersService, ProgramInput } from "./partners.service";
import { StaffDirectoryService } from "./staff-directory.service";

interface InviteBody { email?: string; displayName?: string; roleKey?: string }

/** Keystone: partners (tenants), their company profile and programs (clients). */
@Controller("v1/admin/partners")
@UseGuards(AdminAccessGuard)
export class PartnersController {
  constructor(@Inject(PartnersService) private readonly partners: PartnersService, @Inject(StaffDirectoryService) private readonly staff: StaffDirectoryService) {}

  @Get()
  @RequirePermission("partners.read")
  @AuditAction("partners.list")
  list(@Query() query: { search?: string; status?: string; page?: string; limit?: string }) {
    return this.partners.list(query, pageOf(query));
  }

  @Post()
  @RequirePermission("partners.manage")
  @AuditAction("partners.create", { resourceType: "Tenant" })
  create(@CurrentAdmin() admin: AdminContext, @Body() body: PartnerInput) {
    return this.partners.create(admin, body ?? {});
  }

  @Get(":partnerId")
  @RequirePermission("partners.read")
  @AuditAction("partners.read", { resourceType: "Tenant", resourceParam: "partnerId" })
  get(@Param("partnerId") partnerId: string) {
    return this.partners.get(id(partnerId, "partnerId"));
  }

  @Patch(":partnerId")
  @RequirePermission("partners.manage")
  @AuditAction("partners.update", { resourceType: "Tenant", resourceParam: "partnerId" })
  update(@CurrentAdmin() admin: AdminContext, @Param("partnerId") partnerId: string, @Body() body: PartnerInput) {
    return this.partners.update(admin, id(partnerId, "partnerId"), body ?? {});
  }

  @Post(":partnerId/disable")
  @HttpCode(200)
  @RequirePermission("partners.manage")
  @AuditAction("partners.disable", { resourceType: "Tenant", resourceParam: "partnerId" })
  disable(@CurrentAdmin() admin: AdminContext, @Param("partnerId") partnerId: string) {
    return this.partners.setStatus(admin, id(partnerId, "partnerId"), "DISABLED");
  }

  @Post(":partnerId/enable")
  @HttpCode(200)
  @RequirePermission("partners.manage")
  @AuditAction("partners.enable", { resourceType: "Tenant", resourceParam: "partnerId" })
  enable(@CurrentAdmin() admin: AdminContext, @Param("partnerId") partnerId: string) {
    return this.partners.setStatus(admin, id(partnerId, "partnerId"), "ACTIVE");
  }

  @Post(":partnerId/programs")
  @RequirePermission("partners.manage")
  @AuditAction("programs.create", { resourceType: "Client" })
  createProgram(@CurrentAdmin() admin: AdminContext, @Param("partnerId") partnerId: string, @Body() body: ProgramInput) {
    return this.partners.createProgram(admin, id(partnerId, "partnerId"), body ?? {});
  }

  @Patch(":partnerId/programs/:programId")
  @RequirePermission("partners.manage")
  @AuditAction("programs.update", { resourceType: "Client", resourceParam: "programId" })
  updateProgram(@CurrentAdmin() admin: AdminContext, @Param("partnerId") partnerId: string, @Param("programId") programId: string, @Body() body: ProgramInput) {
    return this.partners.updateProgram(admin, id(partnerId, "partnerId"), id(programId, "programId"), body ?? {});
  }

  @Post(":partnerId/programs/:programId/disable")
  @HttpCode(200)
  @RequirePermission("partners.manage")
  @AuditAction("programs.disable", { resourceType: "Client", resourceParam: "programId" })
  disableProgram(@CurrentAdmin() admin: AdminContext, @Param("partnerId") partnerId: string, @Param("programId") programId: string) {
    return this.partners.setProgramStatus(admin, id(partnerId, "partnerId"), id(programId, "programId"), "DISABLED");
  }

  @Post(":partnerId/programs/:programId/enable")
  @HttpCode(200)
  @RequirePermission("partners.manage")
  @AuditAction("programs.enable", { resourceType: "Client", resourceParam: "programId" })
  enableProgram(@CurrentAdmin() admin: AdminContext, @Param("partnerId") partnerId: string, @Param("programId") programId: string) {
    return this.partners.setProgramStatus(admin, id(partnerId, "partnerId"), id(programId, "programId"), "ACTIVE");
  }

  /** Creates a staff account (if new) with the partner admin role; they sign in by email code. */
  @Post(":partnerId/admins")
  @RequirePermission("partners.manage")
  @AuditAction("partners.admins.invite")
  async inviteAdmin(@CurrentAdmin() admin: AdminContext, @Param("partnerId") partnerId: string, @Body() body: InviteBody) {
    const partner = await this.partners.get(id(partnerId, "partnerId"));
    return this.staff.invite(admin, body ?? {}, { roleKey: "PARTNER_ADMIN", scopeType: "PARTNER", tenantId: partner.id }, partner.name);
  }
}

/** Keystone: field verification vendors. */
@Controller("v1/admin/vendors")
@UseGuards(AdminAccessGuard)
export class VendorsController {
  constructor(@Inject(PartnersService) private readonly partners: PartnersService, @Inject(StaffDirectoryService) private readonly staff: StaffDirectoryService) {}

  @Get()
  @RequirePermission("vendors.read")
  @AuditAction("vendors.list")
  list(@Query() query: { page?: string; limit?: string }) {
    return this.partners.listVendors(pageOf(query));
  }

  @Post()
  @RequirePermission("vendors.manage")
  @AuditAction("vendors.create", { resourceType: "Vendor" })
  create(@CurrentAdmin() admin: AdminContext, @Body() body: { slug?: string; name?: string; contacts?: unknown }) {
    return this.partners.createVendor(admin, body ?? {});
  }

  @Post(":vendorId/disable")
  @HttpCode(200)
  @RequirePermission("vendors.manage")
  @AuditAction("vendors.disable", { resourceType: "Vendor", resourceParam: "vendorId" })
  disable(@CurrentAdmin() admin: AdminContext, @Param("vendorId") vendorId: string) {
    return this.partners.setVendorStatus(admin, id(vendorId, "vendorId"), "DISABLED");
  }

  @Post(":vendorId/enable")
  @HttpCode(200)
  @RequirePermission("vendors.manage")
  @AuditAction("vendors.enable", { resourceType: "Vendor", resourceParam: "vendorId" })
  enable(@CurrentAdmin() admin: AdminContext, @Param("vendorId") vendorId: string) {
    return this.partners.setVendorStatus(admin, id(vendorId, "vendorId"), "ACTIVE");
  }

  @Post(":vendorId/admins")
  @RequirePermission("vendors.manage")
  @AuditAction("vendors.admins.invite")
  async inviteAdmin(@CurrentAdmin() admin: AdminContext, @Param("vendorId") vendorId: string, @Body() body: InviteBody) {
    const vendor = await this.partners.vendor(id(vendorId, "vendorId"));
    return this.staff.invite(admin, body ?? {}, { roleKey: "VENDOR_ADMIN", scopeType: "VENDOR", vendorId: vendor.id }, vendor.name);
  }
}

/** Keystone: its own staff accounts, roles at any scope, and sign-out everywhere. */
@Controller("v1/admin/staff")
@UseGuards(AdminAccessGuard)
export class StaffController {
  constructor(@Inject(StaffDirectoryService) private readonly staff: StaffDirectoryService) {}

  /** The system roles and their permissions, for role pickers. */
  @Get("roles")
  @RequirePermission("staff.read")
  @AuditAction("staff.roles.list")
  roles() {
    return { items: SYSTEM_ROLES };
  }

  @Get()
  @RequirePermission("staff.read")
  @AuditAction("staff.list")
  list() {
    return this.staff.keystoneStaff();
  }

  @Post()
  @RequirePermission("staff.manage")
  @AuditAction("staff.invite")
  invite(@CurrentAdmin() admin: AdminContext, @Body() body: InviteBody) {
    const roleKey = oneOf(body?.roleKey, "roleKey", SYSTEM_ROLES.filter((role) => role.scope === "GLOBAL" && role.key !== "VERIFIER").map((role) => role.key));
    return this.staff.invite(admin, body ?? {}, { roleKey, scopeType: "GLOBAL" }, "Keystone");
  }

  @Get(":userId")
  @RequirePermission("staff.read")
  @AuditAction("staff.read", { resourceType: "PortalUser", resourceParam: "userId" })
  get(@Param("userId") userId: string) {
    return this.staff.account(id(userId, "userId"));
  }

  @Post(":userId/roles")
  @RequirePermission("staff.manage")
  @AuditAction("staff.roles.grant")
  grant(@CurrentAdmin() admin: AdminContext, @Param("userId") userId: string, @Body() body: { roleKey?: string; scopeType?: string; partnerId?: string; vendorId?: string }) {
    return this.staff.grant(admin, id(userId, "userId"), body ?? {});
  }

  @Delete(":userId/roles/:bindingId")
  @RequirePermission("staff.manage")
  @AuditAction("staff.roles.revoke")
  revoke(@CurrentAdmin() admin: AdminContext, @Param("userId") userId: string, @Param("bindingId") bindingId: string) {
    return this.staff.revokeBinding(admin, id(userId, "userId"), id(bindingId, "bindingId"));
  }

  @Post(":userId/disable")
  @HttpCode(200)
  @RequirePermission("staff.manage")
  @AuditAction("staff.disable")
  disable(@CurrentAdmin() admin: AdminContext, @Param("userId") userId: string) {
    return this.staff.setStatus(admin, id(userId, "userId"), "DISABLED");
  }

  @Post(":userId/enable")
  @HttpCode(200)
  @RequirePermission("staff.manage")
  @AuditAction("staff.enable")
  enable(@CurrentAdmin() admin: AdminContext, @Param("userId") userId: string) {
    return this.staff.setStatus(admin, id(userId, "userId"), "ACTIVE");
  }

  /** Bumps the account's sessionVersion: every session it has ends now. */
  @Post(":userId/sessions/revoke")
  @HttpCode(200)
  @RequirePermission("staff.manage")
  @AuditAction("staff.sessions.revoke")
  revokeSessions(@CurrentAdmin() admin: AdminContext, @Param("userId") userId: string) {
    return this.staff.revokeSessions(admin, id(userId, "userId"));
  }
}

/** Partner staff: their company profile and programs. */
@Controller("v1/admin/organisation")
@UseGuards(AdminAccessGuard)
export class OrganisationController {
  constructor(@Inject(PartnersService) private readonly partners: PartnersService) {}

  @Get()
  @RequirePermission("organisation.read")
  @AuditAction("organisation.read", { resourceType: "Tenant" })
  get(@CurrentAdmin() admin: AdminContext) {
    return this.partners.organisation(admin);
  }
}

/** Partner admins: their own team (operators, viewers, other admins). */
@Controller("v1/admin/users")
@UseGuards(AdminAccessGuard)
export class PartnerUsersController {
  constructor(@Inject(StaffDirectoryService) private readonly staff: StaffDirectoryService, @Inject(PrismaService) private readonly prisma: PrismaService) {}

  @Get()
  @RequirePermission("users.read")
  @AuditAction("users.list")
  list(@CurrentAdmin() admin: AdminContext) {
    return this.staff.partnerTeam(admin);
  }

  @Post()
  @RequirePermission("users.manage")
  @AuditAction("users.invite")
  async invite(@CurrentAdmin() admin: AdminContext, @Body() body: InviteBody) {
    const roleKey = oneOf(body?.roleKey, "roleKey", ["PARTNER_ADMIN", "PARTNER_OPERATOR", "PARTNER_VIEWER"] as const);
    const partner = await partnerDb(this.prisma, admin).tenant.findFirstOrThrow({ select: { id: true, name: true } });
    return this.staff.invite(admin, body ?? {}, { roleKey, scopeType: "PARTNER", tenantId: partner.id }, partner.name);
  }

  @Put(":userId/role")
  @RequirePermission("users.manage")
  @AuditAction("users.role.change")
  changeRole(@CurrentAdmin() admin: AdminContext, @Param("userId") userId: string, @Body() body: { roleKey?: string }) {
    return this.staff.changePartnerRole(admin, id(userId, "userId"), body?.roleKey);
  }

  @Delete(":userId")
  @RequirePermission("users.manage")
  @AuditAction("users.remove")
  remove(@CurrentAdmin() admin: AdminContext, @Param("userId") userId: string) {
    return this.staff.removeFromPartner(admin, id(userId, "userId"));
  }
}

/** Vendor admins: their field agents. */
@Controller("v1/admin/vendor-users")
@UseGuards(AdminAccessGuard)
export class VendorUsersController {
  constructor(@Inject(StaffDirectoryService) private readonly staff: StaffDirectoryService, @Inject(PrismaService) private readonly prisma: PrismaService) {}

  @Get()
  @RequirePermission("vendor.users.manage")
  @AuditAction("vendor.users.list")
  list(@CurrentAdmin() admin: AdminContext) {
    return this.staff.vendorTeam(admin);
  }

  @Post()
  @RequirePermission("vendor.users.manage")
  @AuditAction("vendor.users.invite")
  async invite(@CurrentAdmin() admin: AdminContext, @Body() body: InviteBody) {
    const roleKey = oneOf(body?.roleKey, "roleKey", ["VENDOR_ADMIN", "FIELD_AGENT"] as const);
    const vendorId = this.staff.vendorOf(admin);
    const vendor = await this.prisma.vendor.findUniqueOrThrow({ where: { id: vendorId }, select: { name: true } });
    return this.staff.invite(admin, body ?? {}, { roleKey, scopeType: "VENDOR", vendorId }, vendor.name);
  }

  @Delete(":userId")
  @RequirePermission("vendor.users.manage")
  @AuditAction("vendor.users.remove")
  remove(@CurrentAdmin() admin: AdminContext, @Param("userId") userId: string) {
    return this.staff.removeFromVendor(admin, id(userId, "userId"));
  }
}

/** The partner's audit trail (scoped), or every partner's for Keystone staff. */
@Controller("v1/admin/audit-logs")
@UseGuards(AdminAccessGuard)
export class AdminAuditLogsController {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  @Get()
  @RequirePermission("audit.read", { allPartners: true })
  @AuditAction("audit.list")
  async list(@CurrentAdmin() admin: AdminContext, @Query() query: { action?: string; actorUserId?: string; resourceId?: string; outcome?: string; before?: string; limit?: string }) {
    const limit = query.limit === undefined ? 50 : Number(query.limit);
    const take = Number.isInteger(limit) && limit >= 1 && limit <= 200 ? limit : 50;
    const before = optionalDate(query.before, "before");
    const where: Prisma.AuditLogWhereInput = {
      ...(query.action ? { action: String(query.action).slice(0, 120) } : {}),
      ...(query.actorUserId ? { actorUserId: id(query.actorUserId, "actorUserId") } : {}),
      ...(query.resourceId ? { resourceId: String(query.resourceId).slice(0, 120) } : {}),
      ...(query.outcome ? { outcome: oneOf(query.outcome, "outcome", ["SUCCESS", "CLIENT_ERROR", "SERVER_ERROR", "REJECTED"] as const) } : {}),
      ...(before ? { createdAt: { lt: before } } : {})
    };
    const rows = await partnerDb(this.prisma, admin).auditLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take,
      select: { id: true, actorType: true, actorUserId: true, action: true, outcome: true, statusCode: true, tenantId: true, clientId: true, resourceType: true, resourceId: true, method: true, path: true, message: true, metadata: true, createdAt: true }
    });
    return { items: rows, nextBefore: rows.length === take ? rows[rows.length - 1].createdAt.toISOString() : null };
  }
}

/** Keystone finance: billable usage per partner and program. */
@Controller("v1/admin/usage")
@UseGuards(AdminAccessGuard)
export class AdminUsageController {
  constructor(@Inject(UsageService) private readonly usage: UsageService) {}

  @Get()
  @RequirePermission("usage.read")
  @AuditAction("usage.read")
  report(@Query() query: { from?: string; to?: string; partnerId?: string; programId?: string }) {
    return this.usage.getUsage({
      from: parseUsageDate(query.from),
      to: parseUsageDate(query.to),
      tenantId: query.partnerId ? id(query.partnerId, "partnerId") : undefined,
      clientId: query.programId ? id(query.programId, "programId") : undefined
    });
  }
}
