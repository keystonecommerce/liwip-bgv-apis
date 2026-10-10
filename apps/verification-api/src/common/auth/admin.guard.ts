import { CanActivate, ExecutionContext, Injectable, ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import { timingSafeEqual } from "node:crypto";

type HeaderRequest = { headers: Record<string, string | string[] | undefined> };

const firstHeader = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

const safeEqual = (a: string, b: string): boolean => {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
};

/**
 * Guards the /admin surface with a single operator key (env ADMIN_API_KEY),
 * constant-time compared. Fails CLOSED: if ADMIN_API_KEY is unset the whole
 * admin API is unavailable rather than open.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<HeaderRequest>();
    const expected = process.env.ADMIN_API_KEY?.trim();
    if (!expected) {
      throw new ServiceUnavailableException("Admin API is not configured (set ADMIN_API_KEY)");
    }
    const provided = firstHeader(request.headers["x-admin-key"])?.trim();
    if (!provided || !safeEqual(provided, expected)) {
      throw new UnauthorizedException("Invalid or missing X-Admin-Key");
    }
    return true;
  }
}
