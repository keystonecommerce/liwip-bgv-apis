import { ForbiddenException, Inject, Injectable, Logger, NotFoundException, ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransport,
  type RegistrationResponseJSON
} from "@simplewebauthn/server";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../../common/database/prisma.service";
import { adminOrigins } from "../admin-access/admin-config";
import type { AdminContext } from "../admin-access/admin-context";
import { StaffOtpService } from "./staff-otp.service";

const CHALLENGE_TTL_MS = 5 * 60_000;
/** A passkey can be added without an email code this soon after signing in. */
const STEP_UP_WINDOW_MS = 10 * 60_000;
const MAX_PASSKEYS = 10;
const RP_NAME = "Liwip BGV Admin";

type Purpose = "authenticate" | "register";
interface RelyingParty { origin: string; rpId: string }

const SUMMARY = { id: true, name: true, rpId: true, deviceType: true, backedUp: true, createdAt: true, lastUsedAt: true } as const;

/**
 * WebAuthn passkeys for admin sign-in, ported from Keystone Main Backend. The browser
 * origin must be one of ADMIN_PANEL_ORIGINS; the relying party id is that origin's
 * hostname unless ADMIN_WEBAUTHN_RP_ID names a parent domain (e.g. liwip.com).
 * Challenges are stored server-side and single use.
 */
@Injectable()
export class StaffPasskeyService {
  private readonly logger = new Logger(StaffPasskeyService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(StaffOtpService) private readonly otp: StaffOtpService
  ) {}

  async loginOptions(origin: string | undefined) {
    const rp = this.relyingParty(origin);
    // No allowCredentials: the browser offers any passkey it holds for this site.
    const options = await generateAuthenticationOptions({ rpID: rp.rpId, userVerification: "required" });
    const challengeId = await this.saveChallenge("authenticate", rp, options.challenge);
    return { challengeId, options };
  }

  /** The account the passkey belongs to, after a verified assertion. */
  async loginVerify(origin: string | undefined, challengeId: unknown, response: AuthenticationResponseJSON) {
    const rp = this.relyingParty(origin);
    const challenge = await this.consumeChallenge(String(challengeId || ""), "authenticate", rp);
    const passkey = await this.prisma.staffPasskey.findFirst({ where: { credentialId: String(response?.id || ""), rpId: rp.rpId }, include: { user: true } });
    if (!challenge || !passkey || passkey.user.status !== "ACTIVE") throw this.signInFailed();
    const handle = response.response?.userHandle;
    if (handle && Buffer.from(handle, "base64url").toString() !== passkey.userId) throw this.signInFailed();
    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: rp.origin,
        expectedRPID: rp.rpId,
        requireUserVerification: true,
        credential: {
          id: passkey.credentialId,
          publicKey: new Uint8Array(passkey.publicKey),
          counter: Number(passkey.counter),
          transports: (passkey.transports as AuthenticatorTransport[] | null) ?? undefined
        }
      });
    } catch (error) {
      this.logger.warn(`Staff passkey sign-in rejected: ${error instanceof Error ? error.message : String(error)}`);
      throw this.signInFailed();
    }
    if (!verification.verified) throw this.signInFailed();
    await this.prisma.staffPasskey.update({
      where: { id: passkey.id },
      data: { counter: BigInt(verification.authenticationInfo.newCounter), backedUp: verification.authenticationInfo.credentialBackedUp, lastUsedAt: new Date() }
    });
    return passkey.user;
  }

  async registerOptions(admin: AdminContext, origin: string | undefined, code?: string) {
    const rp = this.relyingParty(origin);
    if (Date.now() - admin.authTime.getTime() > STEP_UP_WINDOW_MS) {
      if (!code) throw new ForbiddenException({ message: "Confirm with an email code to add a passkey", code: "PASSKEY_STEP_UP_REQUIRED" });
      const confirmed = await this.otp.verify(admin.user.email, code).catch(() => null);
      if (confirmed?.id !== admin.user.id) throw new ForbiddenException({ message: "The code is incorrect or has expired", code: "PASSKEY_STEP_UP_REQUIRED" });
    }
    const existing = await this.prisma.staffPasskey.findMany({ where: { userId: admin.user.id }, select: { credentialId: true, transports: true, rpId: true } });
    if (existing.length >= MAX_PASSKEYS) throw new ForbiddenException(`You can register up to ${MAX_PASSKEYS} passkeys`);
    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: rp.rpId,
      userID: new TextEncoder().encode(admin.user.id),
      userName: admin.user.email,
      userDisplayName: admin.user.displayName,
      attestationType: "none",
      excludeCredentials: existing.filter((item) => item.rpId === rp.rpId).map((item) => ({ id: item.credentialId, transports: (item.transports as AuthenticatorTransport[] | null) ?? undefined })),
      authenticatorSelection: { residentKey: "required", userVerification: "required" }
    });
    const challengeId = await this.saveChallenge("register", rp, options.challenge, admin.user.id);
    return { challengeId, options };
  }

  async registerVerify(admin: AdminContext, origin: string | undefined, challengeId: unknown, response: RegistrationResponseJSON, name?: unknown) {
    const rp = this.relyingParty(origin);
    const challenge = await this.consumeChallenge(String(challengeId || ""), "register", rp, admin.user.id);
    if (!challenge) throw new UnauthorizedException("Passkey setup expired, try again");
    let verification;
    try {
      verification = await verifyRegistrationResponse({ response, expectedChallenge: challenge, expectedOrigin: rp.origin, expectedRPID: rp.rpId, requireUserVerification: true });
    } catch (error) {
      this.logger.warn(`Staff passkey registration rejected: ${error instanceof Error ? error.message : String(error)}`);
      throw new UnauthorizedException("Passkey could not be verified");
    }
    if (!verification.verified) throw new UnauthorizedException("Passkey could not be verified");
    const info = verification.registrationInfo;
    return this.prisma.staffPasskey.create({
      data: {
        id: `staff_passkey_${randomUUID()}`,
        userId: admin.user.id,
        rpId: rp.rpId,
        credentialId: info.credential.id,
        publicKey: Buffer.from(info.credential.publicKey),
        counter: BigInt(info.credential.counter),
        transports: info.credential.transports ?? [],
        deviceType: info.credentialDeviceType,
        backedUp: info.credentialBackedUp,
        name: String(name ?? "").trim().slice(0, 60) || "Passkey"
      },
      select: SUMMARY
    });
  }

  list(admin: AdminContext) {
    return this.prisma.staffPasskey.findMany({ where: { userId: admin.user.id }, orderBy: { createdAt: "asc" }, select: SUMMARY });
  }

  async remove(admin: AdminContext, id: string) {
    const removed = await this.prisma.staffPasskey.deleteMany({ where: { id, userId: admin.user.id } });
    if (!removed.count) throw new NotFoundException("Passkey not found");
    return { removed: true };
  }

  private relyingParty(origin: string | undefined): RelyingParty {
    const allowed = adminOrigins();
    if (!allowed.length) throw new ServiceUnavailableException("Passkeys are not enabled");
    const normalised = origin?.replace(/\/+$/, "");
    if (!normalised || !allowed.includes(normalised)) throw new ForbiddenException("Passkeys are not enabled for this site");
    const host = new URL(normalised).hostname;
    const configured = process.env.ADMIN_WEBAUTHN_RP_ID?.trim();
    const rpId = configured && (host === configured || host.endsWith(`.${configured}`)) ? configured : host;
    return { origin: normalised, rpId };
  }

  private async saveChallenge(purpose: Purpose, rp: RelyingParty, challenge: string, userId?: string) {
    await this.prisma.staffAuthChallenge.deleteMany({ where: { expiresAt: { lt: new Date() } } });
    const row = await this.prisma.staffAuthChallenge.create({
      data: { id: `staff_challenge_${randomUUID()}`, purpose, userId, rpId: rp.rpId, origin: rp.origin, challenge, expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS) },
      select: { id: true }
    });
    return row.id;
  }

  /** Returns the challenge once; a second use of the same id gets null. */
  private async consumeChallenge(id: string, purpose: Purpose, rp: RelyingParty, userId?: string): Promise<string | null> {
    if (!id || id.length > 100) return null;
    const row = await this.prisma.staffAuthChallenge.findUnique({ where: { id } });
    if (!row) return null;
    const deleted = await this.prisma.staffAuthChallenge.deleteMany({ where: { id } });
    if (deleted.count !== 1 || row.purpose !== purpose || row.rpId !== rp.rpId || row.origin !== rp.origin || (userId !== undefined && row.userId !== userId) || row.expiresAt <= new Date()) return null;
    return row.challenge;
  }

  private signInFailed() {
    return new UnauthorizedException("Passkey sign-in failed");
  }
}
