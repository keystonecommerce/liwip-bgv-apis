import { Injectable } from "@nestjs/common";
import { ThrottlerGuard } from "@nestjs/throttler";
import { isIP } from "node:net";

/** Servers that relay their users' requests (the worker web app): TRUSTED_RELAY_IPS, comma-separated. */
const relays = () => new Set(String(process.env.TRUSTED_RELAY_IPS || "").split(",").map((item) => item.trim()).filter(Boolean));

/**
 * Pre-authentication abuse protection, keyed on Express's trusted IP. A request from a trusted
 * relay is keyed on the person it relays (X-End-User-IP), so one server's users don't share a bucket.
 */
@Injectable()
export class PartnerThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: { ip?: string; headers?: Record<string, string | string[] | undefined> }): Promise<string> {
    const ip = req.ip || "unknown";
    const header = req.headers?.["x-end-user-ip"];
    const relayed = (Array.isArray(header) ? header[0] : header)?.trim();
    if (relayed && isIP(relayed) && relays().has(ip)) return `relayed:${relayed}`;
    return `ip:${ip}`;
  }
}
