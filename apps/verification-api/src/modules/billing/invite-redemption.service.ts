import { ConflictException, ForbiddenException, GoneException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";
import { AuditService } from "../../common/audit/audit.service";
import { issueWorkerToken, WorkerIdentity } from "../../common/auth/worker-token";
import { PrismaService } from "../../common/database/prisma.service";
import type { ApplicationSchema } from "../../domain/verification.types";
import { newCardNumber } from "../verifications/verification.repository";
import { isSelectableCheck, SELECTABLE_CHECKS, type SelectableCheck } from "../worker-cases/worker-case.inputs";
import { checkTypesOf, includedChecks } from "./catalog.service";
import { SeatsService } from "./seats.service";

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
const TOKEN = /^[A-Za-z0-9_-]{20,40}$/;

/**
 * The checks the Liwip worker app walks a person through, for a package's check types. Identity
 * (Aadhaar) comes first in that journey; face checks are one step that needs it. Types the app has
 * no step for yet (address visits, references) stay with the case's package for Keystone to run.
 */
export function journeyChecks(types: readonly string[]): SelectableCheck[] {
  const wanted = new Set<string>(["AADHAAR"]);
  for (const type of types) {
    if (type === "FACE_LIVENESS" || type === "FACE_MATCH") wanted.add("FACE");
    else if (isSelectableCheck(type)) wanted.add(type);
  }
  return (Object.keys(SELECTABLE_CHECKS) as SelectableCheck[]).filter((check) => wanted.has(check));
}

/**
 * A partner's invite link, opened in the Liwip worker app. The person signs in with their phone
 * there; redeeming checks the link is theirs, opens their case under the partner's program with
 * the package's checks, uses the seat, and returns a sign-in token for that program.
 */
@Injectable()
export class InviteRedemptionService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(SeatsService) private readonly seats: SeatsService,
    @Inject(AuditService) private readonly audit: AuditService
  ) {}

  /** What the worker app shows before sign-in. The token is the secret; nothing personal is returned. */
  async preview(token: string) {
    const invite = TOKEN.test(token) ? await this.prisma.invite.findUnique({ where: { tokenHash: hashToken(token) }, include: { tenant: { select: { name: true } } } }) : null;
    if (!invite || invite.status === "CANCELLED") return { status: "INVALID" as const };
    if (invite.status === "EXPIRED" || (invite.status === "SENT" && invite.expiresAt < new Date())) return { status: "EXPIRED" as const, partnerName: invite.tenant.name };
    const pkg = await this.package(invite.packageCode, invite.packageVersion);
    return { status: invite.status === "SENT" ? ("OPEN" as const) : ("STARTED" as const), partnerName: invite.tenant.name, packageName: pkg?.name ?? invite.packageCode, phoneLast4: invite.phone.slice(-4) };
  }

  /** `worker` signed in through the worker app's own key. Safe to repeat: a started invite returns the same case. */
  async redeem(worker: WorkerIdentity, token: string) {
    if (!TOKEN.test(token)) throw new NotFoundException("This link is not valid");
    const result = await this.prisma.$transaction(async (tx) => {
      const found = await tx.invite.findUnique({ where: { tokenHash: hashToken(token) }, select: { id: true, tenantId: true, packageCode: true } });
      if (!found) throw new NotFoundException("This link is not valid");
      await this.seats.lock(tx, found.tenantId, found.packageCode);
      const invite = await tx.invite.findUniqueOrThrow({ where: { id: found.id }, include: { tenant: { select: { name: true, slug: true, status: true } }, } });
      if (invite.status === "CANCELLED") throw new NotFoundException("This link is not valid");
      if (invite.phone !== worker.phone) throw new ForbiddenException(`This link is for the number ending ${invite.phone.slice(-4)}. Sign in with that number.`);
      const client = await tx.client.findUniqueOrThrow({ where: { id: invite.clientId }, select: { code: true, status: true } });
      if (invite.tenant.status !== "ACTIVE" || client.status !== "ACTIVE") throw new GoneException(`${invite.tenant.name} is not taking verifications right now`);

      if (invite.status === "STARTED" || invite.status === "COMPLETED") {
        if (!invite.applicationId) throw new ConflictException("This link was already used");
        return { invite, client, applicationId: invite.applicationId, started: false };
      }
      if (invite.status === "EXPIRED" || invite.expiresAt < new Date()) throw new GoneException(`This link has expired. Ask ${invite.tenant.name} to send a new one.`);

      const pkg = await this.package(invite.packageCode, invite.packageVersion, tx);
      if (!pkg) throw new ConflictException("The package for this link is missing");
      const types = checkTypesOf(pkg.checks);
      const selectedChecks = journeyChecks(types);
      // The seat pays for the bundle (the package plus Aadhaar) and both face steps the journey runs.
      const covered = [...new Set([...includedChecks(pkg.checks), ...selectedChecks.flatMap((check) => SELECTABLE_CHECKS[check].types)])];
      const sponsor = { inviteId: invite.id, partnerName: invite.tenant.name, packageName: pkg.name };
      const data: ApplicationSchema = {
        personal: { phone: worker.phone.slice(2), nameAsAadhaar: invite.name, declaredName: invite.name, dateOfBirth: "" },
        packageCode: invite.packageCode,
        packageVersion: invite.packageVersion,
        selectedChecks,
        sponsor
      };
      // One case per person per program: a draft they already opened there takes the package.
      const existing = await tx.application.findFirst({ where: { tenantId: invite.tenantId, clientId: invite.clientId, workerPhone: worker.phone }, orderBy: { createdAt: "desc" }, select: { id: true, status: true, data: true } });
      let applicationId: string;
      if (existing && existing.status !== "DRAFT") {
        applicationId = existing.id;
      } else if (existing) {
        const current = existing.data as unknown as ApplicationSchema;
        await tx.application.update({ where: { id: existing.id }, data: { packageId: pkg.id, data: { ...current, packageCode: data.packageCode, packageVersion: data.packageVersion, selectedChecks: data.selectedChecks, sponsor } as unknown as Prisma.InputJsonValue } });
        applicationId = existing.id;
      } else {
        const now = new Date();
        applicationId = `app_${randomUUID()}`;
        await tx.application.create({ data: { id: applicationId, tenantId: invite.tenantId, clientId: invite.clientId, packageId: pkg.id, status: "DRAFT", workerPhone: worker.phone, cardNumber: newCardNumber(now), data: data as unknown as Prisma.InputJsonValue, createdAt: now, updatedAt: now } });
      }

      // The seat moves from reserved to used, and the package's checks are paid for on this case.
      const claimed = await tx.invite.updateMany({ where: { id: invite.id, status: "SENT" }, data: { status: "STARTED", startedAt: new Date(), applicationId } });
      if (!claimed.count) throw new ConflictException("This link was just used. Try again.");
      await this.seats.consume(tx, invite);
      await tx.prepaidCase.upsert({
        where: { applicationId },
        create: { applicationId, tenantId: invite.tenantId, source: "SEAT", inviteId: invite.id, packageCode: invite.packageCode, packageVersion: invite.packageVersion, coveredChecks: covered },
        update: { source: "SEAT", inviteId: invite.id, packageCode: invite.packageCode, packageVersion: invite.packageVersion, coveredChecks: covered }
      });
      return { invite, client, applicationId, started: true };
    });

    if (result.started) {
      this.audit.record({ actorType: "PUBLIC", action: "invites.redeem", outcome: "SUCCESS", tenantId: result.invite.tenantId, tenantSlug: result.invite.tenant.slug, clientId: result.invite.clientId, clientCode: result.client.code, resourceType: "Invite", resourceId: result.invite.id, metadata: { applicationId: result.applicationId } });
    }
    const session = issueWorkerToken({
      tenantId: result.invite.tenantId,
      clientId: result.invite.clientId,
      phone: worker.phone,
      invite: { id: result.invite.id, tenantSlug: result.invite.tenant.slug, clientCode: result.client.code }
    });
    return { workerToken: session.token, expiresAt: session.expiresAt, applicationId: result.applicationId, partnerName: result.invite.tenant.name };
  }

  private package(code: string, version: number, db: Prisma.TransactionClient | PrismaService = this.prisma) {
    return db.verificationPackage.findUnique({ where: { code_version: { code, version } }, select: { id: true, name: true, checks: true } });
  }
}
