import { Body, Controller, Delete, ForbiddenException, Get, HttpCode, Inject, Param, Post, Req, Res, UseGuards } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import type { Request, Response } from "express";
import { AuditService } from "../../common/audit/audit.service";
import { PrismaService } from "../../common/database/prisma.service";
import { RateLimitService } from "../../common/security/rate-limit.service";
import { AdminAccessGuard } from "../admin-access/admin-access.guard";
import { firstHeader, recentSignInMs } from "../admin-access/admin-config";
import { AdminContext, AuditAction, CurrentAdmin, SignedIn, SkipAudit } from "../admin-access/admin-context";
import { describeAccess, resolvePermissions, systemRole } from "../admin-access/admin-permissions";
import { StaffSessionService } from "../admin-access/staff-session.service";
import { StaffOtpService } from "./staff-otp.service";
import { StaffPasskeyService } from "./staff-passkey.service";

const origin = (request: Request) => firstHeader(request.headers.origin);

/**
 * Admin panel sign-in. No passwords: an emailed code or a passkey starts a session,
 * which lives in an httpOnly cookie. The CSRF token in the response must be sent as
 * X-CSRF-Token on every state-changing admin request.
 */
@Controller("v1/admin/auth")
export class StaffLoginController {
  constructor(
    @Inject(StaffOtpService) private readonly otp: StaffOtpService,
    @Inject(StaffPasskeyService) private readonly passkeys: StaffPasskeyService,
    @Inject(StaffSessionService) private readonly sessions: StaffSessionService,
    @Inject(RateLimitService) private readonly limits: RateLimitService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(PrismaService) private readonly prisma: PrismaService
  ) {}

  @Post("otp/send")
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async sendOtp(@Req() request: Request, @Body() body: { email?: string }) {
    this.sessions.assertCsrf(request, null);
    await this.limits.consume("staffOtpSendPerIp", request.ip || "unknown");
    const result = await this.otp.send(body?.email, request.ip);
    this.event(request, "auth.otp.send", "SUCCESS", result.userId);
    // Same answer whether or not the address has an account.
    return { sent: true, expiresInSeconds: result.expiresInSeconds };
  }

  @Post("otp/verify")
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async verifyOtp(@Req() request: Request, @Res({ passthrough: true }) response: Response, @Body() body: { email?: string; code?: string }) {
    this.sessions.assertCsrf(request, null);
    await this.limits.consume("staffSignInPerIp", request.ip || "unknown");
    const user = await this.otp.verify(body?.email, body?.code).catch((error) => {
      this.event(request, "auth.login.otp", "REJECTED", null, String(body?.email ?? "").slice(0, 80));
      throw error;
    });
    const session = await this.sessions.start(user, "otp", request, response);
    this.event(request, "auth.login.otp", "SUCCESS", user.id);
    return { ...session, user: { id: user.id, email: user.email, displayName: user.displayName } };
  }

  @Post("passkeys/login/options")
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async passkeyOptions(@Req() request: Request) {
    this.sessions.assertCsrf(request, null);
    await this.limits.consume("staffSignInPerIp", request.ip || "unknown");
    return this.passkeys.loginOptions(origin(request));
  }

  @Post("passkeys/login/verify")
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async passkeyVerify(@Req() request: Request, @Res({ passthrough: true }) response: Response, @Body() body: { challengeId?: string; response?: AuthenticationResponseJSON }) {
    this.sessions.assertCsrf(request, null);
    await this.limits.consume("staffSignInPerIp", request.ip || "unknown");
    const user = await this.passkeys.loginVerify(origin(request), body?.challengeId, body?.response as AuthenticationResponseJSON).catch((error) => {
      this.event(request, "auth.login.passkey", "REJECTED", null);
      throw error;
    });
    const session = await this.sessions.start(user, "passkey", request, response);
    this.event(request, "auth.login.passkey", "SUCCESS", user.id);
    return { ...session, user: { id: user.id, email: user.email, displayName: user.displayName } };
  }

  private event(request: Request, action: string, outcome: "SUCCESS" | "REJECTED", userId: string | null, message?: string) {
    this.audit.record({
      actorType: "STAFF",
      actorUserId: userId,
      action,
      outcome,
      method: request.method,
      path: request.route?.path ?? null,
      ip: request.ip ?? null,
      userAgent: firstHeader(request.headers["user-agent"]) ?? null,
      message: message ?? null
    });
  }
}

/** The signed-in staff member's own session and passkeys. */
@Controller("v1/admin/auth")
@UseGuards(AdminAccessGuard)
@SignedIn()
export class StaffSessionController {
  constructor(
    @Inject(StaffSessionService) private readonly sessions: StaffSessionService,
    @Inject(StaffPasskeyService) private readonly passkeys: StaffPasskeyService,
    @Inject(StaffOtpService) private readonly otp: StaffOtpService,
    @Inject(RateLimitService) private readonly limits: RateLimitService,
    @Inject(PrismaService) private readonly prisma: PrismaService
  ) {}

  /** Who is signed in, the CSRF token, and what they may do where. Polled by the panel, so not audited. */
  @Get("session")
  @SkipAudit()
  async session(@CurrentAdmin() admin: AdminContext) {
    const bindings = admin.bindings;
    const partnerIds = [...new Set(bindings.map((binding) => binding.tenantId).filter((id): id is string => Boolean(id)))];
    const vendorIds = [...new Set(bindings.map((binding) => binding.vendorId).filter((id): id is string => Boolean(id)))];
    const [partners, vendors, verifier] = await Promise.all([
      this.prisma.tenant.findMany({ where: { id: { in: partnerIds } }, select: { id: true, slug: true, name: true, status: true, logoUrl: true }, orderBy: { name: "asc" } }),
      this.prisma.vendor.findMany({ where: { id: { in: vendorIds } }, select: { id: true, slug: true, name: true, status: true }, orderBy: { name: "asc" } }),
      this.prisma.verifierAccess.findUnique({ where: { userId: admin.user.id }, select: { level: true, expiresAt: true, revokedAt: true, organisation: true } })
    ]);
    const roleOf = (binding: (typeof bindings)[number]) => ({ id: binding.id, roleKey: binding.roleKey, roleName: systemRole(binding.roleKey)?.name ?? binding.roleKey, scopeType: binding.scopeType, partnerId: binding.tenantId, vendorId: binding.vendorId });
    return {
      user: admin.user,
      authMethod: admin.authMethod,
      signedInAt: admin.authTime.toISOString(),
      // Powerful actions (@RecentSignIn) need a confirmation after this; the panel asks then.
      recentSignInUntil: new Date(admin.verifiedAt.getTime() + recentSignInMs()).toISOString(),
      csrfToken: this.sessions.csrfToken(admin.sessionId),
      access: {
        ...describeAccess(bindings),
        roles: bindings.map(roleOf),
        partners: partners.map((partner) => ({ ...partner, permissions: [...resolvePermissions(bindings, { kind: "PARTNER", tenantId: partner.id })] })),
        vendors: vendors.map((vendor) => ({ ...vendor, permissions: [...resolvePermissions(bindings, { kind: "VENDOR", vendorId: vendor.id })] })),
        verifier: verifier ? { ...verifier, active: !verifier.revokedAt && (!verifier.expiresAt || verifier.expiresAt > new Date()) } : null
      }
    };
  }

  @Post("logout")
  @HttpCode(200)
  @AuditAction("auth.logout")
  async logout(@CurrentAdmin() admin: AdminContext, @Res({ passthrough: true }) response: Response) {
    await this.sessions.end(admin.sessionId, response);
    return { signedOut: true };
  }

  /** Signs this account out on every device (bumps sessionVersion). */
  @Post("logout-all")
  @HttpCode(200)
  @AuditAction("auth.logout_all")
  async logoutAll(@CurrentAdmin() admin: AdminContext, @Res({ passthrough: true }) response: Response) {
    await this.sessions.revokeAll(admin.user.id);
    this.sessions.clearCookie(response);
    return { signedOut: true };
  }

  /** Confirm it's you before a powerful action: an emailed code to this account's own address. */
  @Post("confirm/otp/send")
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @AuditAction("auth.confirm.otp.send")
  async confirmSend(@CurrentAdmin() admin: AdminContext, @Req() request: Request) {
    await this.limits.consume("staffOtpSendPerIp", request.ip || "unknown");
    const result = await this.otp.send(admin.user.email, request.ip);
    return { sent: true, to: admin.user.email, expiresInSeconds: result.expiresInSeconds };
  }

  @Post("confirm/otp/verify")
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @AuditAction("auth.confirm.otp")
  async confirmVerify(@CurrentAdmin() admin: AdminContext, @Req() request: Request, @Body() body: { code?: string }) {
    await this.limits.consume("staffSignInPerIp", request.ip || "unknown");
    const user = await this.otp.verify(admin.user.email, body?.code);
    if (user.id !== admin.user.id) throw new ForbiddenException("That code is for another account");
    return this.confirmed(admin);
  }

  /** Or with a passkey: the same sign-in ceremony, which must come back as this account. */
  @Post("confirm/passkey/options")
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @SkipAudit()
  confirmPasskeyOptions(@Req() request: Request) {
    return this.passkeys.loginOptions(origin(request));
  }

  @Post("confirm/passkey/verify")
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @AuditAction("auth.confirm.passkey")
  async confirmPasskey(@CurrentAdmin() admin: AdminContext, @Req() request: Request, @Body() body: { challengeId?: string; response?: AuthenticationResponseJSON }) {
    await this.limits.consume("staffSignInPerIp", request.ip || "unknown");
    const user = await this.passkeys.loginVerify(origin(request), body?.challengeId, body?.response as AuthenticationResponseJSON);
    if (user.id !== admin.user.id) throw new ForbiddenException("That passkey belongs to another account");
    return this.confirmed(admin);
  }

  private async confirmed(admin: AdminContext) {
    const verifiedAt = await this.sessions.markVerified(admin.sessionId);
    return { confirmed: true, recentSignInUntil: new Date(verifiedAt.getTime() + recentSignInMs()).toISOString() };
  }

  @Get("passkeys")
  list(@CurrentAdmin() admin: AdminContext) {
    return this.passkeys.list(admin);
  }

  @Post("passkeys/register/options")
  @HttpCode(200)
  @AuditAction("auth.passkey.register_options")
  registerOptions(@CurrentAdmin() admin: AdminContext, @Req() request: Request, @Body() body: { code?: string }) {
    return this.passkeys.registerOptions(admin, origin(request), body?.code);
  }

  @Post("passkeys/register/verify")
  @HttpCode(201)
  @AuditAction("auth.passkey.add", { resourceType: "StaffPasskey" })
  registerVerify(@CurrentAdmin() admin: AdminContext, @Req() request: Request, @Body() body: { challengeId?: string; response?: RegistrationResponseJSON; name?: string }) {
    return this.passkeys.registerVerify(admin, origin(request), body?.challengeId, body?.response as RegistrationResponseJSON, body?.name);
  }

  @Delete("passkeys/:id")
  @AuditAction("auth.passkey.remove", { resourceType: "StaffPasskey", resourceParam: "id" })
  remove(@CurrentAdmin() admin: AdminContext, @Param("id") id: string) {
    return this.passkeys.remove(admin, id);
  }
}
