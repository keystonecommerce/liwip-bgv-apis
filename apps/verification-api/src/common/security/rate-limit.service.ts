import { ExecutionContext, HttpException, Injectable, OnModuleDestroy, ServiceUnavailableException, createParamDecorator } from "@nestjs/common";
import IORedis from "ioredis";
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { redisConnectionOptions } from "../../config/redis";
import type { RequestWithClient } from "../auth/client-context";

/** Safety limits per person or per worker, in seconds windows. Each can be tuned by env. */
export const LIMITS = {
  otpSendPerIp: { env: "LIMIT_OTP_SEND_PER_IP_HOUR", limit: 10, window: 3600, message: "Too many codes requested from this network. Try again later." },
  otpVerifyPerIp: { env: "LIMIT_OTP_VERIFY_PER_IP_15MIN", limit: 20, window: 900, message: "Too many attempts. Wait a few minutes and try again." },
  passkeyLoginPerIp: { env: "LIMIT_PASSKEY_LOGIN_PER_IP_10MIN", limit: 20, window: 600, message: "Too many sign-in attempts. Wait a few minutes and try again." },
  passkeySetupPerWorker: { env: "LIMIT_PASSKEY_SETUP_PER_WORKER_HOUR", limit: 5, window: 3600, message: "Too many quick sign-in attempts. Try again later." },
  checkPerWorkerHour: { env: "LIMIT_CHECKS_PER_WORKER_HOUR", limit: 15, window: 3600, message: "You have submitted many checks this hour. Try again later." },
  checkPerWorkerDay: { env: "LIMIT_CHECKS_PER_WORKER_DAY", limit: 40, window: 86400, message: "You have reached today's limit for checks. Try again tomorrow." },
  aadhaarPerWorker: { env: "LIMIT_AADHAAR_PER_WORKER_HOUR", limit: 10, window: 3600, message: "Too many Aadhaar attempts. Try again in an hour." },
  caseEditsPerWorker: { env: "LIMIT_CASE_EDITS_PER_WORKER_HOUR", limit: 30, window: 3600, message: "Too many changes. Try again later." }
} as const;

export type LimitName = keyof typeof LIMITS;

/**
 * Fixed-window counters in Redis, shared by every replica. Fails closed: if the
 * counter store is down, the guarded action is refused rather than unlimited.
 */
@Injectable()
export class RateLimitService implements OnModuleDestroy {
  private readonly redis = new IORedis({ ...redisConnectionOptions(), maxRetriesPerRequest: 1, enableOfflineQueue: false });

  constructor() {
    this.redis.on("error", () => {});
  }

  /** Counts one use of `name` for `subject` (an IP or worker), throwing 429 once over the limit. */
  async consume(name: LimitName, subject: string): Promise<void> {
    const rule = LIMITS[name];
    const configured = Number(process.env[rule.env]);
    const limit = Number.isSafeInteger(configured) && configured > 0 ? configured : rule.limit;
    // Subjects are hashed so phone numbers and IPs are not stored in Redis keys.
    const key = `liwip:limit:${name}:${createHash("sha256").update(subject).digest("hex").slice(0, 32)}`;
    let count: number;
    try {
      count = Number(await this.redis.eval("local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end; return n", 1, key, String(rule.window)));
    } catch {
      throw new ServiceUnavailableException("Service is busy. Try again shortly.");
    }
    if (count > limit) throw new HttpException(rule.message, 429);
  }

  /** Clears one subject's counters, e.g. when support gives a worker a fresh start. */
  async clear(names: LimitName[], subject: string): Promise<void> {
    const digest = createHash("sha256").update(subject).digest("hex").slice(0, 32);
    await this.redis.del(...names.map((name) => `liwip:limit:${name}:${digest}`)).catch(() => undefined);
  }

  async onModuleDestroy() {
    this.redis.disconnect();
  }
}

/**
 * The end user's IP. A partner server (like the worker web app) relays it in
 * X-End-User-IP; it is trusted only after ApiKeyGuard has authenticated the
 * caller, and falls back to the connecting IP.
 */
export const EndUserIp = createParamDecorator((_data: unknown, context: ExecutionContext): string => {
  const request = context.switchToHttp().getRequest<RequestWithClient & { ip?: string; headers: Record<string, string | string[] | undefined> }>();
  const header = request.headers["x-end-user-ip"];
  const relayed = (Array.isArray(header) ? header[0] : header)?.trim();
  if (request.clientContext && relayed && isIP(relayed)) return relayed;
  return request.ip || "unknown";
});
