import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../../common/database/prisma.service";
import { canonicalCardNumber } from "../../domain/card-number";
import { hashIp, panelUrl } from "../admin-access/admin-config";
import { AdminContext } from "../admin-access/admin-context";
import { hasPermission } from "../admin-access/admin-permissions";
import { StaffSessionService } from "../admin-access/staff-session.service";
import { resolveCardToken } from "../cards/card-token";
import { matchedPhoto, photoDataUrl, publicCardView, verifierCardView } from "../cards/card-views";
import { EMAIL_SENDER, EmailSender, inviteEmail } from "../staff-auth/email-sender";
import { normaliseEmail } from "../staff-auth/staff-otp.service";
import { CasesService } from "./cases.service";
import { Page, oneOf, optionalDate, optionalText, paginated, text } from "./input";
import { StaffDirectoryService } from "./staff-directory.service";

const CARD_INCLUDE = {
  application: { select: { id: true, tenantId: true, data: true, verifications: { select: { type: true, status: true, createdAt: true, completedAt: true, updatedAt: true } } } }
} satisfies Prisma.VerificationCardInclude;

export const normaliseCardNumber = (value: unknown) => {
  const cardNumber = canonicalCardNumber(value);
  if (!cardNumber) throw new BadRequestException("cardNumber is not valid");
  return cardNumber;
};

type Via = "PRINT" | "APP" | "NUMBER";

/**
 * Staff card lookups and Keystone's verifier accounts.
 *
 * A lookup is by QR token or card number only; there is no listing or search by phone.
 * What the viewer gets:
 * - staff with cards.read for the card's partner: the full case (partner staff see it as
 *   of the relationship end if the worker left; Keystone staff see it live),
 * - a verifier with active access: the verifier view (SCOPED: any card scanned by QR,
 *   by number only cards granted to them or that they scanned before; UNIVERSAL: any card),
 * - anyone else signed in: the public view.
 * Every lookup is logged in CardScan and the audit log (who, when, which card, which view).
 */
@Injectable()
export class CardLookupService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CasesService) private readonly cases: CasesService,
    @Inject(StaffDirectoryService) private readonly staff: StaffDirectoryService,
    @Inject(StaffSessionService) private readonly sessions: StaffSessionService,
    @Inject(EMAIL_SENDER) private readonly email: EmailSender
  ) {}

  async lookup(admin: AdminContext, input: { token?: unknown; cardNumber?: unknown }, ip?: string) {
    if ((input.token === undefined) === (input.cardNumber === undefined)) throw new BadRequestException("Send either token or cardNumber");
    let via: Via;
    let where: Prisma.VerificationCardWhereUniqueInput;
    if (input.token !== undefined) {
      const resolved = resolveCardToken(String(input.token).slice(0, 200));
      if (!resolved) throw new NotFoundException("This code is not valid or has expired");
      via = resolved.via;
      where = { publicId: resolved.publicId };
    } else {
      via = "NUMBER";
      where = { cardNumber: normaliseCardNumber(input.cardNumber) };
    }
    const card = await this.prisma.verificationCard.findUnique({ where, include: CARD_INCLUDE });
    if (!card) {
      admin.audit = { resourceType: "VerificationCard", metadata: { via, found: false } };
      throw new NotFoundException("Card not found");
    }
    admin.audit = { tenantId: card.tenantId, clientId: card.clientId, resourceType: "VerificationCard", resourceId: card.id, metadata: { via } };

    // 1. Staff who may see this partner's cases get the full case.
    if (hasPermission(admin.bindings, "cards.read", { kind: "PARTNER", tenantId: card.tenantId }) && hasPermission(admin.bindings, "cases.read", { kind: "PARTNER", tenantId: card.tenantId })) {
      const tenant = await this.prisma.tenant.findUnique({ where: { id: card.tenantId }, select: { slug: true, status: true } });
      if (tenant?.status === "ACTIVE") {
        const keystone = hasPermission(admin.bindings, "cards.read", { kind: "ALL_PARTNERS" });
        const scoped: AdminContext = { ...admin, scope: { kind: "PARTNER", tenantId: card.tenantId, tenantSlug: tenant.slug }, audit: admin.audit };
        const detail = await this.cases.detail(scoped, card.applicationId);
        admin.audit = { ...scoped.audit, resourceType: "VerificationCard", resourceId: card.id, metadata: { via, view: "FULL", caseId: card.applicationId } };
        await this.logScan(card, via, ip, admin, keystone ? "KEYSTONE" : "PARTNER", "FULL", keystone ? null : card.tenantId);
        return { view: "FULL" as const, case: detail };
      }
    }

    const photo = photoDataUrl(await matchedPhoto(this.prisma, card.applicationId));
    const view = { card, checks: card.application.verifications, data: card.application.data, photo };

    // 2. Verifiers, within the access Keystone granted.
    if (hasPermission(admin.bindings, "cards.verify", { kind: "GLOBAL" })) {
      const access = await this.prisma.verifierAccess.findUnique({ where: { userId: admin.user.id }, include: { cards: { where: { cardId: card.id }, select: { id: true } } } });
      const active = access && !access.revokedAt && (!access.expiresAt || access.expiresAt > new Date());
      if (!active) throw new ForbiddenException("Your verifier access has ended");
      if (access.level === "SCOPED" && via === "NUMBER" && !access.cards.length) {
        admin.audit = { ...admin.audit, metadata: { via, denied: "card not granted" } };
        throw new ForbiddenException("Scan this card's QR code; you can look up a card by number only after scanning it or when Keystone grants it");
      }
      if (access.level === "SCOPED" && via !== "NUMBER" && !access.cards.length) {
        await this.prisma.verifierCardGrant.create({ data: { id: `verifier_card_${randomUUID()}`, verifierAccessId: access.id, cardId: card.id, source: "SCANNED" } }).catch(() => undefined);
      }
      admin.audit = { ...admin.audit, metadata: { via, view: "VERIFIER", level: access.level } };
      await this.logScan(card, via, ip, admin, "VERIFIER", "VERIFIER", null);
      return verifierCardView(view);
    }

    // 3. Everyone else: another partner's worker, or staff without card access.
    const viewerTenantId = admin.bindings.find((binding) => binding.scopeType === "PARTNER")?.tenantId ?? null;
    admin.audit = { ...admin.audit, metadata: { via, view: "PUBLIC" } };
    await this.logScan(card, via, ip, admin, viewerTenantId ? "PARTNER" : "STAFF", "PUBLIC", viewerTenantId);
    return publicCardView(view);
  }

  private async logScan(card: { id: string; tenantId: string; clientId: string; status: string; expiresAt: Date }, via: Via, ip: string | undefined, admin: AdminContext, viewerType: string, view: string, viewerTenantId: string | null) {
    await this.prisma.cardScan.create({
      data: {
        id: `card_scan_${randomUUID()}`, cardId: card.id, tenantId: card.tenantId, clientId: card.clientId, via,
        result: card.status !== "ACTIVE" ? "SUSPENDED" : card.expiresAt.getTime() <= Date.now() ? "EXPIRED" : "VALID",
        ipHash: hashIp(ip) ?? "unknown", viewerType, viewerUserId: admin.user.id, viewerTenantId, view
      }
    });
  }

  // --- Verifier accounts (Keystone, verifiers.manage) ---

  async listVerifiers(page: Page) {
    const [items, total] = await Promise.all([
      this.prisma.verifierAccess.findMany({
        orderBy: { createdAt: "desc" }, skip: page.skip, take: page.limit,
        include: { user: { select: { id: true, email: true, displayName: true, status: true, lastLoginAt: true } }, _count: { select: { cards: true } } }
      }),
      this.prisma.verifierAccess.count()
    ]);
    return paginated(items.map(({ _count, ...access }) => ({ ...access, cardCount: _count.cards, active: !access.revokedAt && (!access.expiresAt || access.expiresAt > new Date()) })), total, page);
  }

  async createVerifier(admin: AdminContext, input: { email?: unknown; displayName?: unknown; organisation?: unknown; purpose?: unknown; level?: unknown; expiresAt?: unknown; cardNumbers?: unknown }) {
    this.staff.assertCanGrant(admin, { roleKey: "VERIFIER", scopeType: "GLOBAL" });
    const email = normaliseEmail(input.email);
    const displayName = text(input.displayName, "displayName", 80);
    const level = oneOf(input.level, "level", ["SCOPED", "UNIVERSAL"] as const);
    const expiresAt = optionalDate(input.expiresAt, "expiresAt") ?? null;
    if (expiresAt && expiresAt <= new Date()) throw new BadRequestException("expiresAt must be in the future");
    const cardIds = await this.cardIds(input.cardNumbers);
    const created = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.portalUser.findUnique({ where: { email }, select: { id: true, status: true, verifierAccess: { select: { id: true } } } });
      if (existing?.verifierAccess) throw new ConflictException("This account already has verifier access");
      if (existing && existing.status !== "ACTIVE") throw new ConflictException("This account is disabled");
      const user = existing ?? await tx.portalUser.create({ data: { id: `staff_${randomUUID()}`, email, displayName, status: "ACTIVE", invitedById: admin.user.id }, select: { id: true } });
      await tx.staffRoleBinding.upsert({
        where: { userId_roleKey_scopeKey: { userId: user.id, roleKey: "VERIFIER", scopeKey: "GLOBAL" } },
        update: {},
        create: { id: `binding_${randomUUID()}`, userId: user.id, roleKey: "VERIFIER", scopeType: "GLOBAL", scopeKey: "GLOBAL", grantedById: admin.user.id }
      });
      const access = await tx.verifierAccess.create({
        data: { id: `verifier_${randomUUID()}`, userId: user.id, level, expiresAt, organisation: optionalText(input.organisation, "organisation", 120) ?? null, purpose: optionalText(input.purpose, "purpose", 300) ?? null, grantedById: admin.user.id }
      });
      if (cardIds.length) await tx.verifierCardGrant.createMany({ data: cardIds.map((cardId) => ({ id: `verifier_card_${randomUUID()}`, verifierAccessId: access.id, cardId, source: "GRANTED", grantedById: admin.user.id })) });
      return { user, access };
    });
    admin.audit = { resourceType: "PortalUser", resourceId: created.user.id, metadata: { level, expiresAt: expiresAt?.toISOString() ?? null, cards: cardIds.length } };
    await this.email.send(inviteEmail(email, displayName, "Liwip BGV card verification", panelUrl("business"))).catch(() => undefined);
    return { ...created.access, email, cardCount: cardIds.length };
  }

  async updateVerifier(admin: AdminContext, userId: string, input: { level?: unknown; expiresAt?: unknown }) {
    this.staff.assertCanGrant(admin, { roleKey: "VERIFIER", scopeType: "GLOBAL" });
    const access = await this.access(userId);
    const expiresAt = optionalDate(input.expiresAt, "expiresAt");
    const updated = await this.prisma.verifierAccess.update({
      where: { id: access.id },
      data: { level: input.level === undefined ? undefined : oneOf(input.level, "level", ["SCOPED", "UNIVERSAL"] as const), expiresAt }
    });
    admin.audit = { resourceType: "PortalUser", resourceId: userId, metadata: { level: updated.level, expiresAt: updated.expiresAt?.toISOString() ?? null } };
    return updated;
  }

  async grantCards(admin: AdminContext, userId: string, input: { cardNumbers?: unknown }) {
    this.staff.assertCanGrant(admin, { roleKey: "VERIFIER", scopeType: "GLOBAL" });
    const access = await this.access(userId);
    const cardIds = await this.cardIds(input.cardNumbers);
    if (!cardIds.length) throw new BadRequestException("cardNumbers must list at least one card");
    const result = await this.prisma.verifierCardGrant.createMany({ data: cardIds.map((cardId) => ({ id: `verifier_card_${randomUUID()}`, verifierAccessId: access.id, cardId, source: "GRANTED", grantedById: admin.user.id })), skipDuplicates: true });
    admin.audit = { resourceType: "PortalUser", resourceId: userId, metadata: { cardIds } };
    return { granted: result.count };
  }

  async removeCard(admin: AdminContext, userId: string, cardId: string) {
    this.staff.assertCanGrant(admin, { roleKey: "VERIFIER", scopeType: "GLOBAL" });
    const access = await this.access(userId);
    const removed = await this.prisma.verifierCardGrant.deleteMany({ where: { verifierAccessId: access.id, cardId } });
    if (!removed.count) throw new NotFoundException("This card is not granted to the verifier");
    admin.audit = { resourceType: "PortalUser", resourceId: userId, metadata: { cardId } };
    return { removed: true };
  }

  /** Ends verifier access now: the role is removed and, if it was their only role, every session ends. */
  async revokeVerifier(admin: AdminContext, userId: string) {
    this.staff.assertCanGrant(admin, { roleKey: "VERIFIER", scopeType: "GLOBAL" });
    const access = await this.access(userId);
    await this.prisma.$transaction([
      this.prisma.verifierAccess.update({ where: { id: access.id }, data: { revokedAt: access.revokedAt ?? new Date(), revokedById: admin.user.id } }),
      this.prisma.staffRoleBinding.deleteMany({ where: { userId, roleKey: "VERIFIER", scopeType: "GLOBAL" } })
    ]);
    if (!(await this.prisma.staffRoleBinding.count({ where: { userId } }))) await this.sessions.revokeAll(userId);
    admin.audit = { resourceType: "PortalUser", resourceId: userId };
    return { revoked: true };
  }

  /** One verifier's lookups, newest first. */
  async lookups(userId: string, page: Page) {
    const where = { viewerUserId: userId };
    const [items, total] = await Promise.all([
      this.prisma.cardScan.findMany({ where, orderBy: { scannedAt: "desc" }, skip: page.skip, take: page.limit, select: { id: true, via: true, result: true, view: true, scannedAt: true, card: { select: { id: true, cardNumber: true } } } }),
      this.prisma.cardScan.count({ where })
    ]);
    return paginated(items, total, page);
  }

  private async access(userId: string) {
    const access = await this.prisma.verifierAccess.findUnique({ where: { userId } });
    if (!access) throw new NotFoundException("Verifier not found");
    return access;
  }

  private async cardIds(value: unknown): Promise<string[]> {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value) || value.length > 500) throw new BadRequestException("cardNumbers must be a list of up to 500 card numbers");
    const numbers = [...new Set(value.map(normaliseCardNumber))];
    const cards = await this.prisma.verificationCard.findMany({ where: { cardNumber: { in: numbers } }, select: { id: true, cardNumber: true } });
    const missing = numbers.filter((number) => !cards.some((card) => card.cardNumber === number));
    if (missing.length) throw new BadRequestException(`Unknown card numbers: ${missing.join(", ")}`);
    return cards.map((card) => card.id);
  }
}
