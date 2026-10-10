import { BadRequestException, Inject, Injectable, Logger, OnModuleDestroy, ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON
} from "@simplewebauthn/server";
import IORedis from "ioredis";
import { createHash, createHmac, randomUUID } from "node:crypto";
import type { ClientContext } from "../../common/auth/client-context";
import { issueWorkerToken, type WorkerIdentity } from "../../common/auth/worker-token";
import { PrismaService } from "../../common/database/prisma.service";
import { redisConnectionOptions } from "../../config/redis";

const CHALLENGE_TTL_SECONDS = 300;

interface RelyingParty { id: string; name: string; origins: string[] }

/** WEBAUTHN_RP_ID is the site's domain (bgv.liwip.com); WEBAUTHN_ORIGINS lists the exact origins allowed. */
function relyingParty(): RelyingParty {
  const id = process.env.WEBAUTHN_RP_ID?.trim();
  const origins = (process.env.WEBAUTHN_ORIGINS || "").split(",").map((item) => item.trim()).filter(Boolean);
  if (!id || !origins.length) throw new ServiceUnavailableException("Quick sign-in is not configured");
  return { id, name: process.env.WEBAUTHN_RP_NAME?.trim() || "Liwip", origins };
}

/** Challenge from the browser's signed client data; it is the key we stored the expectation under. */
function challengeOf(response: { response?: { clientDataJSON?: string } }): string {
  try {
    const clientData = JSON.parse(Buffer.from(String(response?.response?.clientDataJSON || ""), "base64url").toString("utf8")) as { challenge?: string };
    if (typeof clientData.challenge === "string" && /^[\w-]{16,200}$/.test(clientData.challenge)) return clientData.challenge;
  } catch {
    // fall through
  }
  throw new BadRequestException("The passkey response is not valid");
}

/**
 * Passkeys let a worker sign in again without an OTP. Registration needs a
 * worker token (OTP already done); a verified sign-in returns a new worker token.
 */
@Injectable()
export class WorkerPasskeyService implements OnModuleDestroy {
  private readonly logger = new Logger(WorkerPasskeyService.name);
  private readonly redis = new IORedis(redisConnectionOptions());

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async registrationOptions(worker: WorkerIdentity, displayName?: string) {
    const rp = relyingParty();
    const existing = await this.prisma.workerPasskey.findMany({
      where: { tenantId: worker.tenantId, clientId: worker.clientId, workerPhone: worker.phone },
      select: { credentialId: true, transports: true }
    });
    const national = worker.phone.slice(2);
    const options = await generateRegistrationOptions({
      rpName: rp.name,
      rpID: rp.id,
      // Stable per worker and platform, and not the phone number itself.
      userID: new Uint8Array(createHmac("sha256", this.userIdSecret()).update(`${worker.tenantId}:${worker.clientId}:${worker.phone}`).digest()),
      userName: `+91 ${national.slice(0, 5)} ${national.slice(5)}`,
      userDisplayName: displayName?.trim().slice(0, 64) || `+91 ${national}`,
      attestationType: "none",
      excludeCredentials: existing.map((item) => ({ id: item.credentialId, transports: (item.transports as string[] | null) ?? undefined })),
      // A passkey on this phone, unlocked by its fingerprint or screen lock.
      authenticatorSelection: { residentKey: "required", userVerification: "required", authenticatorAttachment: "platform" },
      timeout: CHALLENGE_TTL_SECONDS * 1000
    });
    await this.redis.set(this.registrationKey(worker), options.challenge, "EX", CHALLENGE_TTL_SECONDS);
    return options;
  }

  async verifyRegistration(worker: WorkerIdentity, response: RegistrationResponseJSON) {
    const rp = relyingParty();
    const expected = await this.redis.getdel(this.registrationKey(worker));
    if (!expected) throw new BadRequestException("Quick sign-in setup expired. Try again.");
    const result = await verifyRegistrationResponse({
      response,
      expectedChallenge: expected,
      expectedOrigin: rp.origins,
      expectedRPID: rp.id,
      requireUserVerification: true
    }).catch((error: Error) => {
      this.logger.warn(`Passkey registration rejected: ${error.message}`);
      throw new BadRequestException("This passkey could not be verified");
    });
    if (!result.verified) throw new BadRequestException("This passkey could not be verified");
    const { credential, credentialDeviceType, credentialBackedUp } = result.registrationInfo;
    await this.prisma.workerPasskey.create({
      data: {
        id: `passkey_${randomUUID()}`,
        tenantId: worker.tenantId,
        clientId: worker.clientId,
        workerPhone: worker.phone,
        credentialId: credential.id,
        publicKey: Buffer.from(credential.publicKey),
        counter: credential.counter,
        transports: credential.transports ?? undefined,
        deviceType: credentialDeviceType,
        backedUp: credentialBackedUp
      }
    });
    return { registered: true };
  }

  /** Usernameless: the phone picks the worker's passkey, so no phone number is sent or revealed. */
  async authenticationOptions(client: ClientContext) {
    const rp = relyingParty();
    const options = await generateAuthenticationOptions({ rpID: rp.id, userVerification: "required", timeout: CHALLENGE_TTL_SECONDS * 1000 });
    await this.redis.set(this.authenticationKey(client, options.challenge), "1", "EX", CHALLENGE_TTL_SECONDS);
    return options;
  }

  async verifyAuthentication(client: ClientContext, response: AuthenticationResponseJSON) {
    const rp = relyingParty();
    const challenge = challengeOf(response);
    // Single use, and only for the platform that asked for it.
    if (!(await this.redis.getdel(this.authenticationKey(client, challenge)))) throw new UnauthorizedException("Sign-in expired. Try again.");
    const passkey = await this.prisma.workerPasskey.findFirst({
      where: { credentialId: String(response?.id || ""), tenantId: client.tenantId, clientId: client.clientId }
    });
    if (!passkey) throw new UnauthorizedException("This passkey is not registered. Sign in with your mobile number.");
    const result = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: rp.origins,
      expectedRPID: rp.id,
      requireUserVerification: true,
      credential: {
        id: passkey.credentialId,
        publicKey: new Uint8Array(passkey.publicKey),
        counter: passkey.counter,
        transports: (passkey.transports as string[] | null) ?? undefined
      }
    }).catch((error: Error) => {
      this.logger.warn(`Passkey sign-in rejected: ${error.message}`);
      throw new UnauthorizedException("This passkey could not be verified");
    });
    if (!result.verified) throw new UnauthorizedException("This passkey could not be verified");
    await this.prisma.workerPasskey.update({
      where: { id: passkey.id },
      data: { counter: result.authenticationInfo.newCounter, lastUsedAt: new Date(), backedUp: result.authenticationInfo.credentialBackedUp }
    });
    const session = issueWorkerToken({ tenantId: client.tenantId, clientId: client.clientId, phone: passkey.workerPhone });
    return { verified: true, phone: passkey.workerPhone.slice(2), workerToken: session.token, workerTokenExpiresAt: session.expiresAt };
  }

  private registrationKey(worker: WorkerIdentity) {
    const phone = createHash("sha256").update(worker.phone).digest("hex");
    return `liwip:webauthn:register:${worker.tenantId}:${worker.clientId}:${phone}`;
  }

  private authenticationKey(client: ClientContext, challenge: string) {
    return `liwip:webauthn:login:${client.tenantId}:${client.clientId}:${challenge}`;
  }

  private userIdSecret(): string {
    const secret = process.env.WORKER_TOKEN_SECRET;
    if (!secret || secret.length < 32) throw new ServiceUnavailableException("Quick sign-in is not configured");
    return secret;
  }

  async onModuleDestroy() {
    this.redis.disconnect();
  }
}
