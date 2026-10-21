import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../../common/database/prisma.service";
import { AdminContext, partnerDb } from "../admin-access/admin-context";
import { BindingLike, canGrant, GrantRequest, SYSTEM_ROLES, systemRole } from "../admin-access/admin-permissions";
import { StaffSessionService } from "../admin-access/staff-session.service";
import { panelUrl } from "../admin-access/admin-config";
import { EMAIL_SENDER, EmailSender, inviteEmail } from "../staff-auth/email-sender";
import { normaliseEmail } from "../staff-auth/staff-otp.service";
import { oneOf, text } from "./input";

const USER_SUMMARY = { id: true, email: true, displayName: true, status: true, lastLoginAt: true, createdAt: true } as const;

export const scopeKeyOf = (grant: GrantRequest) =>
  grant.scopeType === "PARTNER" ? `partner:${grant.tenantId}` : grant.scopeType === "VENDOR" ? `vendor:${grant.vendorId}` : "GLOBAL";

const roleSummary = (binding: { id: string; roleKey: string; scopeType: string; tenantId: string | null; vendorId: string | null; createdAt?: Date }) => ({
  id: binding.id,
  roleKey: binding.roleKey,
  roleName: systemRole(binding.roleKey)?.name ?? binding.roleKey,
  scopeType: binding.scopeType,
  partnerId: binding.tenantId,
  vendorId: binding.vendorId,
  createdAt: binding.createdAt
});

/**
 * Staff accounts and role bindings: inviting, changing and removing people at a scope.
 * Every grant and removal goes through canGrant, so nobody can hand out (or take away)
 * access they do not hold themselves. Partner staff only touch their partner's bindings,
 * through the scoped client.
 */
@Injectable()
export class StaffDirectoryService {
  private readonly logger = new Logger(StaffDirectoryService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(StaffSessionService) private readonly sessions: StaffSessionService,
    @Inject(EMAIL_SENDER) private readonly email: EmailSender
  ) {}

  assertCanGrant(actor: AdminContext, grant: GrantRequest) {
    const decision = canGrant(actor.bindings, grant);
    if (!decision.allowed) throw new ForbiddenException(decision.reason);
  }

  /**
   * Creates the account if needed and grants the role. Existing accounts are found by
   * email (a platform identity); the binding is the only thing written for the scope.
   */
  async invite(actor: AdminContext, input: { email?: unknown; displayName?: unknown }, grant: GrantRequest, organisation: string) {
    if (grant.roleKey === "VERIFIER") throw new BadRequestException("Create verifiers from the verifiers page");
    this.assertCanGrant(actor, grant);
    const email = normaliseEmail(input.email);
    const displayName = text(input.displayName, "displayName", 80);
    const write = grant.scopeType === "PARTNER" && actor.scope.kind === "PARTNER" ? partnerDb(this.prisma, actor) : this.prisma;
    const existing = await this.prisma.portalUser.findUnique({ where: { email }, select: { id: true, status: true } });
    if (existing && existing.status !== "ACTIVE") throw new ConflictException("This account is disabled. Ask Keystone to enable it.");
    const user = existing ?? await write.portalUser.create({
      data: {
        id: `staff_${randomUUID()}`,
        email,
        displayName,
        status: "ACTIVE",
        tenantId: grant.scopeType === "PARTNER" ? grant.tenantId : null,
        invitedById: actor.user.id
      },
      select: { id: true, status: true }
    }).catch((error: unknown) => {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") throw new ConflictException("This email was just invited. Try again.");
      throw error;
    });
    const binding = await write.staffRoleBinding.upsert({
      where: { userId_roleKey_scopeKey: { userId: user.id, roleKey: grant.roleKey, scopeKey: scopeKeyOf(grant) } },
      update: {},
      create: {
        id: `binding_${randomUUID()}`,
        userId: user.id,
        roleKey: grant.roleKey,
        scopeType: grant.scopeType,
        scopeKey: scopeKeyOf(grant),
        tenantId: grant.tenantId ?? null,
        vendorId: grant.vendorId ?? null,
        grantedById: actor.user.id
      }
    });
    actor.audit = { tenantId: grant.tenantId ?? null, resourceType: "PortalUser", resourceId: user.id, metadata: { roleKey: grant.roleKey, scopeType: grant.scopeType, vendorId: grant.vendorId ?? null, newAccount: !existing } };
    // Best effort: the person can still sign in by requesting a code.
    await this.email.send(inviteEmail(email, displayName, organisation, panelUrl(grant.scopeType === "GLOBAL" ? "control" : "business"))).catch((error: unknown) => this.logger.warn(`Invite email not sent: ${error instanceof Error ? error.message : String(error)}`));
    return { user: { id: user.id, email, displayName: existing ? undefined : displayName, newAccount: !existing }, binding: roleSummary(binding) };
  }

  /** A partner's team: everyone with a binding at this partner (scoped client). */
  async partnerTeam(actor: AdminContext) {
    const bindings = await partnerDb(this.prisma, actor).staffRoleBinding.findMany({
      where: { scopeType: "PARTNER" },
      include: { user: { select: USER_SUMMARY } },
      orderBy: { createdAt: "asc" }
    });
    return this.groupByUser(bindings);
  }

  /** Removes everything a person holds at this partner. */
  async removeFromPartner(actor: AdminContext, userId: string) {
    if (userId === actor.user.id) throw new BadRequestException("You cannot remove yourself");
    const db = partnerDb(this.prisma, actor);
    const bindings = await db.staffRoleBinding.findMany({ where: { userId, scopeType: "PARTNER" } });
    if (!bindings.length) throw new NotFoundException("This person is not on your team");
    for (const binding of bindings) this.assertCanGrant(actor, binding);
    await db.staffRoleBinding.deleteMany({ where: { userId, scopeType: "PARTNER", id: { in: bindings.map((binding) => binding.id) } } });
    actor.audit = { resourceType: "PortalUser", resourceId: userId, metadata: { removedRoles: bindings.map((binding) => binding.roleKey) } };
    return { removed: bindings.length };
  }

  /** Replaces a person's role at this partner. */
  async changePartnerRole(actor: AdminContext, userId: string, roleKeyInput: unknown) {
    if (actor.scope.kind !== "PARTNER") throw new BadRequestException("Choose a partner (x-partner-id)");
    if (userId === actor.user.id) throw new BadRequestException("You cannot change your own role");
    const roleKey = oneOf(roleKeyInput, "roleKey", SYSTEM_ROLES.filter((role) => role.scope === "PARTNER").map((role) => role.key));
    const tenantId = actor.scope.tenantId;
    const db = partnerDb(this.prisma, actor);
    const current = await db.staffRoleBinding.findMany({ where: { userId, scopeType: "PARTNER" } });
    if (!current.length) throw new NotFoundException("This person is not on your team");
    for (const binding of current) this.assertCanGrant(actor, binding);
    const grant = { roleKey, scopeType: "PARTNER", tenantId };
    this.assertCanGrant(actor, grant);
    // Interactive transactions on the scoped client keep its tenant filter.
    await db.$transaction(async (tx) => {
      await tx.staffRoleBinding.deleteMany({ where: { userId, tenantId, scopeType: "PARTNER" } });
      await tx.staffRoleBinding.create({ data: { id: `binding_${randomUUID()}`, userId, roleKey, scopeType: "PARTNER", scopeKey: scopeKeyOf(grant), tenantId, grantedById: actor.user.id } });
    });
    actor.audit = { resourceType: "PortalUser", resourceId: userId, metadata: { from: current.map((binding) => binding.roleKey), to: roleKey } };
    return { userId, roleKey };
  }

  /** A vendor's team (vendor admins and field agents). */
  async vendorTeam(actor: AdminContext) {
    const vendorId = this.vendorOf(actor);
    const bindings = await this.prisma.staffRoleBinding.findMany({ where: { scopeType: "VENDOR", vendorId }, include: { user: { select: USER_SUMMARY } }, orderBy: { createdAt: "asc" } });
    return this.groupByUser(bindings);
  }

  async removeFromVendor(actor: AdminContext, userId: string) {
    const vendorId = this.vendorOf(actor);
    if (userId === actor.user.id) throw new BadRequestException("You cannot remove yourself");
    const bindings = await this.prisma.staffRoleBinding.findMany({ where: { userId, scopeType: "VENDOR", vendorId } });
    if (!bindings.length) throw new NotFoundException("This person is not on your team");
    for (const binding of bindings) this.assertCanGrant(actor, binding);
    await this.prisma.staffRoleBinding.deleteMany({ where: { id: { in: bindings.map((binding) => binding.id) }, vendorId } });
    actor.audit = { resourceType: "PortalUser", resourceId: userId, metadata: { vendorId, removedRoles: bindings.map((binding) => binding.roleKey) } };
    return { removed: bindings.length };
  }

  vendorOf(actor: AdminContext): string {
    if (actor.scope.kind !== "VENDOR") throw new BadRequestException("Choose a vendor (x-vendor-id)");
    return actor.scope.vendorId;
  }

  /** Keystone staff: accounts with a global role other than verifier. */
  async keystoneStaff() {
    const bindings = await this.prisma.staffRoleBinding.findMany({
      where: { scopeType: "GLOBAL", roleKey: { not: "VERIFIER" } },
      include: { user: { select: USER_SUMMARY } },
      orderBy: { createdAt: "asc" }
    });
    return this.groupByUser(bindings);
  }

  async account(userId: string) {
    const user = await this.prisma.portalUser.findUnique({
      where: { id: userId },
      select: { ...USER_SUMMARY, tenantId: true, bindings: { orderBy: { createdAt: "asc" } }, verifierAccess: { select: { level: true, expiresAt: true, revokedAt: true } }, _count: { select: { passkeys: true } } }
    });
    if (!user) throw new NotFoundException("Account not found");
    const { bindings, _count, ...rest } = user;
    return { ...rest, passkeys: _count.passkeys, roles: bindings.map(roleSummary) };
  }

  async grant(actor: AdminContext, userId: string, input: { roleKey?: unknown; scopeType?: unknown; partnerId?: unknown; vendorId?: unknown }) {
    const scopeType = oneOf(input.scopeType, "scopeType", ["GLOBAL", "PARTNER", "VENDOR"] as const);
    const grant: GrantRequest = {
      roleKey: String(input.roleKey ?? "").toUpperCase(),
      scopeType,
      tenantId: scopeType === "PARTNER" ? String(input.partnerId ?? "") || null : null,
      vendorId: scopeType === "VENDOR" ? String(input.vendorId ?? "") || null : null
    };
    if (grant.roleKey === "VERIFIER") throw new BadRequestException("Create verifiers from the verifiers page");
    this.assertCanGrant(actor, grant);
    const user = await this.prisma.portalUser.findUnique({ where: { id: userId }, select: { id: true, status: true } });
    if (!user) throw new NotFoundException("Account not found");
    if (grant.tenantId && !(await this.prisma.tenant.count({ where: { id: grant.tenantId } }))) throw new NotFoundException("Partner not found");
    if (grant.vendorId && !(await this.prisma.vendor.count({ where: { id: grant.vendorId } }))) throw new NotFoundException("Vendor not found");
    const binding = await this.prisma.staffRoleBinding.upsert({
      where: { userId_roleKey_scopeKey: { userId, roleKey: grant.roleKey, scopeKey: scopeKeyOf(grant) } },
      update: {},
      create: { id: `binding_${randomUUID()}`, userId, roleKey: grant.roleKey, scopeType, scopeKey: scopeKeyOf(grant), tenantId: grant.tenantId, vendorId: grant.vendorId, grantedById: actor.user.id }
    });
    actor.audit = { tenantId: grant.tenantId ?? null, resourceType: "PortalUser", resourceId: userId, metadata: { roleKey: grant.roleKey, scopeType, vendorId: grant.vendorId } };
    return roleSummary(binding);
  }

  async revokeBinding(actor: AdminContext, userId: string, bindingId: string) {
    const binding = await this.prisma.staffRoleBinding.findFirst({ where: { id: bindingId, userId } });
    if (!binding) throw new NotFoundException("Role not found");
    if (binding.roleKey === "VERIFIER") throw new BadRequestException("Revoke verifiers from the verifiers page");
    if (userId === actor.user.id) throw new BadRequestException("You cannot remove your own role");
    this.assertCanGrant(actor, binding);
    await this.prisma.staffRoleBinding.delete({ where: { id: binding.id } });
    actor.audit = { tenantId: binding.tenantId, resourceType: "PortalUser", resourceId: userId, metadata: { roleKey: binding.roleKey, scopeType: binding.scopeType } };
    return { removed: true };
  }

  /** Disables an account and signs it out everywhere. Only someone who could grant all its roles may do it. */
  async setStatus(actor: AdminContext, userId: string, status: "ACTIVE" | "DISABLED") {
    if (userId === actor.user.id) throw new BadRequestException("You cannot change your own account status");
    await this.assertOutranks(actor, userId);
    await this.prisma.portalUser.update({ where: { id: userId }, data: { status } });
    if (status === "DISABLED") await this.sessions.revokeAll(userId);
    actor.audit = { resourceType: "PortalUser", resourceId: userId, metadata: { status } };
    return { id: userId, status };
  }

  async revokeSessions(actor: AdminContext, userId: string) {
    await this.assertOutranks(actor, userId);
    await this.sessions.revokeAll(userId);
    actor.audit = { resourceType: "PortalUser", resourceId: userId };
    return { revoked: true };
  }

  private async assertOutranks(actor: AdminContext, userId: string) {
    const user = await this.prisma.portalUser.findUnique({ where: { id: userId }, select: { id: true, bindings: true } });
    if (!user) throw new NotFoundException("Account not found");
    for (const binding of user.bindings as BindingLike[]) this.assertCanGrant(actor, binding);
  }

  private groupByUser(bindings: Array<{ id: string; roleKey: string; scopeType: string; tenantId: string | null; vendorId: string | null; createdAt: Date; user: Record<string, unknown> & { id: string } }>) {
    const people = new Map<string, Record<string, unknown> & { roles: ReturnType<typeof roleSummary>[] }>();
    for (const binding of bindings) {
      const entry = people.get(binding.user.id) ?? { ...binding.user, roles: [] };
      entry.roles.push(roleSummary(binding));
      people.set(binding.user.id, entry);
    }
    return { items: [...people.values()] };
  }
}
