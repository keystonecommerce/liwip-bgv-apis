import { Injectable } from "@nestjs/common";
import { ThrottlerGuard } from "@nestjs/throttler";
import { createHash } from "node:crypto";

type ThrottledRequest = {
  ip?: string;
  headers?: Record<string, string | string[] | undefined>;
};

const firstHeader = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

/**
 * Rate-limits PER PARTNER API KEY rather than per source IP, so one partner
 * can't exhaust a shared bucket for everyone (the default IP tracker collapses
 * to the load balancer's IP behind a proxy). Runs as a global guard BEFORE
 * ApiKeyGuard, so it keys off the presented X-API-Key header (hashed, never
 * stored raw), falling back to admin key, then client IP.
 */
@Injectable()
export class PartnerThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: ThrottledRequest): Promise<string> {
    const apiKey = firstHeader(req?.headers?.["x-api-key"]);
    if (apiKey) return `key:${createHash("sha256").update(apiKey).digest("hex").slice(0, 24)}`;

    const adminKey = firstHeader(req?.headers?.["x-admin-key"]);
    if (adminKey) return `admin:${createHash("sha256").update(adminKey).digest("hex").slice(0, 24)}`;

    const forwarded = firstHeader(req?.headers?.["x-forwarded-for"]);
    const ip = forwarded?.split(",")[0]?.trim() || req?.ip || "unknown";
    return `ip:${ip}`;
  }
}
