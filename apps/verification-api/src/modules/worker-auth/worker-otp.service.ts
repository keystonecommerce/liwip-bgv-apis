import {
  BadGatewayException,
  BadRequestException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  ServiceUnavailableException,
  UnauthorizedException
} from "@nestjs/common";
import { createHash, createHmac, randomInt, timingSafeEqual } from "node:crypto";
import IORedis from "ioredis";
import type { ClientContext } from "../../common/auth/client-context";
import { issueWorkerToken } from "../../common/auth/worker-token";
import { Msg91OtpProvider } from "../../integrations/msg91/msg91-otp.provider";
import { Msg91ProviderError } from "../../integrations/msg91/msg91.types";

interface StoredOtpChallenge {
  digest: string;
  createdAt: number;
}

function redisConnectionOptions() {
  return {
    host: process.env.REDIS_HOST || "127.0.0.1",
    port: Number(process.env.REDIS_PORT || 6380),
    maxRetriesPerRequest: null as null
  };
}

@Injectable()
export class WorkerOtpService implements OnModuleDestroy {
  private readonly logger = new Logger(WorkerOtpService.name);
  private readonly redis = new IORedis(redisConnectionOptions());

  constructor(@Inject(Msg91OtpProvider) private readonly provider: Msg91OtpProvider) {}

  async send(phone: string, client: ClientContext) {
    const mobile = this.normaliseIndianMobile(phone);
    return this.deliver(mobile, client, false);
  }

  async verify(phone: string, otp: string, client: ClientContext) {
    const mobile = this.normaliseIndianMobile(phone);
    if (!/^\d{6}$/.test(otp)) throw new BadRequestException("Enter a valid six-digit OTP.");
    const keys = this.keys(mobile, client);
    const maxAttempts = this.intSetting("MSG91_OTP_MAX_VERIFY_ATTEMPTS", 5, 1, 10);
    const attempts = Number(await this.redis.get(keys.verifyAttempts) || 0);
    if (attempts >= maxAttempts) this.tooManyRequests("Too many incorrect OTP attempts. Request a new OTP.");

    const encoded = await this.redis.get(keys.challenge);
    if (!encoded) throw new UnauthorizedException("The OTP is incorrect or expired.");

    let challenge: StoredOtpChallenge;
    try {
      challenge = JSON.parse(encoded) as StoredOtpChallenge;
    } catch {
      await this.redis.del(keys.challenge);
      throw new UnauthorizedException("The OTP is incorrect or expired.");
    }

    const supplied = Buffer.from(this.otpDigest(mobile, otp, client), "hex");
    const expected = Buffer.from(challenge.digest, "hex");
    const matches = supplied.length === expected.length && timingSafeEqual(supplied, expected);
    if (!matches) {
      const currentAttempts = await this.incrementWindow(keys.verifyAttempts, this.expirySeconds());
      if (currentAttempts >= maxAttempts) await this.redis.del(keys.challenge);
      throw new UnauthorizedException("The OTP is incorrect or expired.");
    }

    await this.redis.del(keys.challenge, keys.verifyAttempts, keys.cooldown);
    // Only a key that may open worker cases receives a worker token.
    const session = client.scopes.includes("worker:cases")
      ? issueWorkerToken({ tenantId: client.tenantId, clientId: client.clientId, phone: mobile })
      : undefined;
    return { success: true, verified: true, message: "Mobile number verified successfully.", workerToken: session?.token, workerTokenExpiresAt: session?.expiresAt };
  }

  async resend(phone: string, client: ClientContext) {
    const mobile = this.normaliseIndianMobile(phone);
    return this.deliver(mobile, client, true);
  }

  private async deliver(mobile: string, client: ClientContext, resend: boolean) {
    const keys = this.keys(mobile, client);
    const cooldownSeconds = this.intSetting("MSG91_OTP_RESEND_AFTER_SECONDS", 60, 30, 300);
    const maxSends = this.intSetting("MSG91_OTP_MAX_SENDS_PER_HOUR", 5, 1, 20);
    const cooldownSet = await this.redis.set(keys.cooldown, "1", "EX", cooldownSeconds, "NX");
    if (!cooldownSet) this.tooManyRequests(`Please wait ${cooldownSeconds} seconds before ${resend ? "resending" : "requesting"} the OTP.`);

    const sends = await this.incrementWindow(keys.sendCount, 60 * 60);
    if (sends > maxSends) {
      await this.decrementWindow(keys.sendCount);
      await this.redis.del(keys.cooldown);
      this.tooManyRequests("Too many OTP requests. Please try again later.");
    }

    const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
    const challenge: StoredOtpChallenge = {
      digest: this.otpDigest(mobile, code, client),
      createdAt: Date.now()
    };
    await this.redis.set(keys.challenge, JSON.stringify(challenge), "EX", this.expirySeconds());
    await this.redis.del(keys.verifyAttempts);

    // Local testing without MSG91: print the code instead of sending it. Never in production.
    if (process.env.OTP_DEV_LOG === "true" && process.env.NODE_ENV !== "production") {
      this.logger.warn(`OTP_DEV_LOG: OTP for ******${mobile.slice(-4)} is ${code}`);
      return { success: true, message: "OTP sent successfully.", requestId: null, expiresInSeconds: this.expirySeconds(), resendAfterSeconds: cooldownSeconds };
    }

    try {
      const result = await this.provider.sendOtp(mobile, code);
      this.logger.log(`MSG91 accepted OTP Flow request requestId=${result.request_id || "unavailable"} tenant=${client.tenantId} client=${client.clientId}`);
      return {
        success: true,
        message: resend ? "OTP resent successfully." : "OTP sent successfully.",
        requestId: result.request_id || null,
        expiresInSeconds: this.expirySeconds(),
        resendAfterSeconds: cooldownSeconds
      };
    } catch (error) {
      await this.redis.del(keys.challenge, keys.cooldown);
      await this.decrementWindow(keys.sendCount);
      throw this.providerFailure(error);
    }
  }

  private normaliseIndianMobile(input: string): string {
    const digits = String(input || "").replace(/\D/g, "");
    const national = digits.length === 12 && digits.startsWith("91") ? digits.slice(2) : digits;
    if (!/^[6-9]\d{9}$/.test(national)) throw new BadRequestException("Enter a valid 10-digit Indian mobile number.");
    return `91${national}`;
  }

  private keys(mobile: string, client: ClientContext) {
    const phoneHash = createHash("sha256").update(mobile).digest("hex");
    const prefix = `liwip:otp:${client.tenantId}:${client.clientId}:${phoneHash}`;
    return {
      challenge: `${prefix}:challenge`,
      cooldown: `${prefix}:cooldown`,
      sendCount: `${prefix}:send-count`,
      verifyAttempts: `${prefix}:verify-attempts`
    };
  }

  private otpDigest(mobile: string, otp: string, client: ClientContext): string {
    const secret = (process.env.OTP_HASH_SECRET || "").trim();
    if (secret.length < 32) throw new ServiceUnavailableException("OTP hashing is not configured securely.");
    return createHmac("sha256", secret)
      .update(`${client.tenantId}:${client.clientId}:${mobile}:${otp}`)
      .digest("hex");
  }

  private async incrementWindow(key: string, ttlSeconds: number): Promise<number> {
    const count = await this.redis.incr(key);
    if (count === 1) await this.redis.expire(key, ttlSeconds);
    return count;
  }

  private async decrementWindow(key: string): Promise<void> {
    const count = await this.redis.decr(key);
    if (count <= 0) await this.redis.del(key);
  }

  private expirySeconds(): number {
    return this.intSetting("MSG91_OTP_EXPIRY_MINUTES", 5, 1, 30) * 60;
  }

  private intSetting(name: string, fallback: number, minimum: number, maximum: number): number {
    const parsed = Number(process.env[name]);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(maximum, Math.max(minimum, Math.floor(parsed)));
  }

  private providerFailure(error: unknown) {
    if (!(error instanceof Msg91ProviderError)) return new BadGatewayException("The OTP provider returned an unexpected response.");
    this.logger.warn(`MSG91 OTP Flow request failed status=${error.statusCode} reason=${error.message}`);
    if ([401, 403, 503].includes(error.statusCode)) {
      return new ServiceUnavailableException("The OTP service is not configured or is temporarily unavailable.");
    }
    return new BadGatewayException(`MSG91 could not send the OTP: ${error.message}`);
  }

  private tooManyRequests(message: string): never {
    throw new HttpException(message, HttpStatus.TOO_MANY_REQUESTS);
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit();
  }
}
