import { ServiceUnavailableException } from "@nestjs/common";
import { createHash, createHmac } from "node:crypto";

/**
 * Admin panel session settings. The panel is a separate SPA on a sibling subdomain
 * (admin.liwip.com) calling this API (api.liwip.com): same site, so a SameSite=Lax cookie
 * set by the API is sent with credentialed fetches, while other sites never get it.
 */
export function adminAuthSecret(): string {
  const secret = process.env.ADMIN_AUTH_SECRET?.trim();
  if (!secret || secret.length < 32) throw new ServiceUnavailableException("Admin sign-in is not configured (set ADMIN_AUTH_SECRET)");
  return secret;
}

export const adminHmac = (purpose: string, value: string) => createHmac("sha256", adminAuthSecret()).update(`${purpose}\0${value}`).digest("base64url");

/** Not reversible to the address, but stable for spotting abuse from one network. */
export const hashIp = (ip: string | undefined) => (ip ? adminHmac("ip", ip).slice(0, 32) : null);

export const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

export interface CookieSettings { name: string; secure: boolean; maxAgeMs: number }

export function cookieSettings(): CookieSettings {
  const production = process.env.NODE_ENV === "production";
  // Secure is the default. Only a non-production http://localhost setup may turn it off.
  const secure = production || process.env.ADMIN_COOKIE_SECURE !== "false";
  const hours = Number(process.env.ADMIN_SESSION_TTL_HOURS || 12);
  const ttl = Number.isFinite(hours) && hours >= 1 && hours <= 72 ? hours : 12;
  // __Host- pins the cookie to the API host: Secure, Path=/ and no Domain attribute.
  const name = process.env.ADMIN_SESSION_COOKIE?.trim() || (secure ? "__Host-liwip_admin" : "liwip_admin");
  return { name, secure, maxAgeMs: ttl * 3_600_000 };
}

/**
 * How long a sign-in, a confirmation or the last powerful action counts as recent for
 * @RecentSignIn routes. Sliding: each powerful action restarts it. ADMIN_RECENT_SIGN_IN_MINUTES, default 60.
 */
export function recentSignInMs(): number {
  const minutes = Number(process.env.ADMIN_RECENT_SIGN_IN_MINUTES || 60);
  return (Number.isFinite(minutes) && minutes > 0 ? minutes : 60) * 60_000;
}

/**
 * Where people sign in. Keystone staff use the control panel; partner and vendor staff and
 * verifiers use the business portal. ADMIN_PANEL_URL is the fallback for both.
 */
export function panelUrl(app: "control" | "business"): string {
  const fallback = process.env.ADMIN_PANEL_URL?.trim() || "http://localhost:4312";
  const url = (app === "control" ? process.env.ADMIN_CONTROL_URL : process.env.ADMIN_BUSINESS_URL)?.trim() || fallback;
  return url.replace(/\/+$/, "");
}

/** Exact origins of both apps (ADMIN_PANEL_ORIGINS, comma separated). */
export function adminOrigins(): string[] {
  return (process.env.ADMIN_PANEL_ORIGINS || "").split(/[\s,]+/).map((origin) => origin.trim().replace(/\/+$/, "")).filter(Boolean);
}

export function readCookie(header: string | string[] | undefined, name: string): string | undefined {
  const raw = Array.isArray(header) ? header.join("; ") : header;
  if (!raw) return undefined;
  for (const part of raw.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export const firstHeader = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value)?.trim() || undefined;
