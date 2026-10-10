import { Injectable } from "@nestjs/common";
import { ThrottlerGuard } from "@nestjs/throttler";
/** Pre-authentication abuse protection. Only Express's configured trusted IP is used. */
@Injectable()
export class PartnerThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: { ip?: string }): Promise<string> {
    return `ip:${req.ip || "unknown"}`;
  }
}
