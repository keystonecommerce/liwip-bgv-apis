import { HttpException, Injectable, OnModuleDestroy, ServiceUnavailableException } from "@nestjs/common";
import IORedis from "ioredis";
import { redisConnectionOptions } from "../../config/redis";
import { createHash } from "node:crypto";
/** Shared quota per authenticated organization, across replicas and rotated keys. */
@Injectable()
export class PartnerRateLimitService implements OnModuleDestroy {
  private readonly redis = new IORedis({ ...redisConnectionOptions(), maxRetriesPerRequest: 1, enableOfflineQueue: false });
  constructor() { this.redis.on("error", () => {}); }
  async check(clientId: string): Promise<void> {
    const limit = Number(process.env.PARTNER_RATE_LIMIT || 120);
    if (!Number.isSafeInteger(limit) || limit < 1) throw new ServiceUnavailableException("Partner quota is not configured correctly");
    const key = `bgv:partner-quota:${createHash("sha256").update(clientId).digest("hex")}`;
    let count: number;
    try {
      count = Number(await this.redis.eval("local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('PEXPIRE',KEYS[1],60000) end; return n", 1, key));
    } catch { throw new ServiceUnavailableException("Partner quota service is unavailable"); }
    if (count > limit) throw new HttpException("Partner request limit exceeded", 429);
  }
  async onModuleDestroy() { this.redis.disconnect(); }
}
