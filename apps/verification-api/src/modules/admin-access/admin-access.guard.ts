import { BadRequestException, CanActivate, ExecutionContext, ForbiddenException, HttpException, Inject, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { AuditService } from "../../common/audit/audit.service";
import { PrismaService } from "../../common/database/prisma.service";
import { firstHeader, recentSignInMs } from "./admin-config";
import { ADMIN_PERMISSION, ADMIN_RECENT, ADMIN_SIGNED_IN, AdminBinding, AdminContext, AdminRequest, AdminScope, PermissionRule } from "./admin-context";
import { AccessTarget, boundPartnerIds, boundVendorIds, hasPermission, permissionDefinition, resolvePermissions } from "./admin-permissions";
import { StaffSessionService } from "./staff-session.service";

const ID = /^[A-Za-z0-9_-]{1,100}$/;

/**
 * The one guard of the admin panel API. In order:
 * 1. authenticates the session cookie (401),
 * 2. checks CSRF on state-changing requests (403),
 * 3. resolves the request scope: GLOBAL; one partner (x-partner-id for global staff, the
 *    binding for partner staff); every partner (global staff, routes that allow it); or a
 *    vendor likewise, and checks the partner or vendor exists and is ACTIVE for everyone,
 *    platform admins included,
 * 4. checks the route's permission at that scope from role bindings only (403),
 * and puts the result on request.admin. Routes without an access rule are refused.
 */
@Injectable()
export class AdminAccessGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(StaffSessionService) private readonly sessions: StaffSessionService,
    @Inject(AuditService) private readonly audit: AuditService
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AdminRequest>();
    const targets = [context.getHandler(), context.getClass()];
    const rule = this.reflector.getAllAndOverride<PermissionRule | undefined>(ADMIN_PERMISSION, targets);
    const signedInOnly = this.reflector.getAllAndOverride<boolean | undefined>(ADMIN_SIGNED_IN, targets);
    if (!rule && !signedInOnly) throw new ForbiddenException("This route has no access rule");

    const session = await this.sessions.authenticate(request);
    const bindings: AdminBinding[] = await this.prisma.staffRoleBinding.findMany({
      where: { userId: session.user.id },
      select: { id: true, roleKey: true, scopeType: true, tenantId: true, vendorId: true }
    });
    const admin: AdminContext = {
      user: session.user,
      sessionId: session.id,
      authMethod: session.authMethod,
      authTime: session.createdAt,
      verifiedAt: session.verifiedAt,
      bindings,
      scope: { kind: "NONE" },
      permissions: new Set(),
      audit: {}
    };
    request.admin = admin;

    try {
      this.sessions.assertCsrf(request, session.id);
      if (rule) {
        admin.scope = await this.resolveScope(request, bindings, rule);
        admin.permissions = resolvePermissions(bindings, this.target(admin.scope));
        if (!admin.permissions.has(rule.permission)) throw new ForbiddenException("You do not have access to this");
      }
      if (this.reflector.getAllAndOverride<boolean | undefined>(ADMIN_RECENT, targets) && Date.now() - session.verifiedAt.getTime() > recentSignInMs()) {
        throw new ForbiddenException({ statusCode: 403, error: "Forbidden", code: "RECENT_SIGN_IN_REQUIRED", message: "Confirm it's you to continue" });
      }
    } catch (error) {
      if (error instanceof HttpException) {
        this.audit.record({
          actorType: "STAFF",
          actorUserId: session.user.id,
          action: "admin.access.denied",
          outcome: "REJECTED",
          method: request.method,
          path: request.route?.path ?? null,
          statusCode: error.getStatus(),
          tenantId: admin.scope.kind === "PARTNER" ? admin.scope.tenantId : null,
          ip: request.ip ?? request.socket?.remoteAddress ?? null,
          userAgent: firstHeader(request.headers["user-agent"]) ?? null,
          message: error.message,
          metadata: rule ? { permission: rule.permission, partnerHeader: firstHeader(request.headers["x-partner-id"]) ?? null } : undefined
        });
      }
      throw error;
    }
    return true;
  }

  private target(scope: AdminScope): AccessTarget {
    switch (scope.kind) {
      case "PARTNER": return { kind: "PARTNER", tenantId: scope.tenantId };
      case "VENDOR": return { kind: "VENDOR", vendorId: scope.vendorId };
      case "ALL_PARTNERS": return { kind: "ALL_PARTNERS" };
      case "ALL_VENDORS": return { kind: "ALL_VENDORS" };
      default: return { kind: "GLOBAL" };
    }
  }

  private async resolveScope(request: AdminRequest, bindings: AdminBinding[], rule: PermissionRule): Promise<AdminScope> {
    const definition = permissionDefinition(rule.permission);
    if (!definition) throw new ForbiddenException("Unknown permission");
    if (definition.scope === "GLOBAL") return { kind: "GLOBAL" };
    if (definition.scope === "PARTNER") return this.partnerScope(request, bindings, rule);
    return this.vendorScope(request, bindings, rule);
  }

  private async partnerScope(request: AdminRequest, bindings: AdminBinding[], rule: PermissionRule): Promise<AdminScope> {
    const header = firstHeader(request.headers["x-partner-id"]);
    let tenantId: string;
    if (header) {
      if (!ID.test(header)) throw new BadRequestException("x-partner-id is not valid");
      tenantId = header;
    } else {
      const everyPartner = hasPermission(bindings, rule.permission, { kind: "ALL_PARTNERS" });
      const bound = boundPartnerIds(bindings, rule.permission);
      if (everyPartner) {
        if (rule.allPartners) return { kind: "ALL_PARTNERS" };
        throw new BadRequestException("Choose a partner (x-partner-id)");
      }
      if (bound.length > 1) throw new BadRequestException("Choose a partner (x-partner-id)");
      if (!bound.length) throw new ForbiddenException("You do not have access to this");
      tenantId = bound[0];
    }
    // Permission first, so partner staff cannot probe which other partner ids exist.
    if (!hasPermission(bindings, rule.permission, { kind: "PARTNER", tenantId })) throw new ForbiddenException("You do not have access to this partner");
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { id: true, slug: true, status: true } });
    if (!tenant || tenant.status !== "ACTIVE") throw new ForbiddenException("This partner is not active");
    return { kind: "PARTNER", tenantId: tenant.id, tenantSlug: tenant.slug };
  }

  private async vendorScope(request: AdminRequest, bindings: AdminBinding[], rule: PermissionRule): Promise<AdminScope> {
    const header = firstHeader(request.headers["x-vendor-id"]);
    let vendorId: string;
    if (header) {
      if (!ID.test(header)) throw new BadRequestException("x-vendor-id is not valid");
      vendorId = header;
    } else {
      const everyVendor = hasPermission(bindings, rule.permission, { kind: "ALL_VENDORS" });
      const bound = boundVendorIds(bindings, rule.permission);
      if (everyVendor) {
        if (rule.allVendors) return { kind: "ALL_VENDORS" };
        throw new BadRequestException("Choose a vendor (x-vendor-id)");
      }
      if (bound.length > 1) throw new BadRequestException("Choose a vendor (x-vendor-id)");
      if (!bound.length) throw new ForbiddenException("You do not have access to this");
      vendorId = bound[0];
    }
    if (!hasPermission(bindings, rule.permission, { kind: "VENDOR", vendorId })) throw new ForbiddenException("You do not have access to this vendor");
    const vendor = await this.prisma.vendor.findUnique({ where: { id: vendorId }, select: { id: true, status: true } });
    if (!vendor || vendor.status !== "ACTIVE") throw new ForbiddenException("This vendor is not active");
    return { kind: "VENDOR", vendorId: vendor.id };
  }
}
