import { ServiceUnavailableException } from "@nestjs/common";
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Card QR tokens. The printed card carries the card's random publicId (fixed,
 * revocable by reissuing). The app shows a live token that expires in two
 * minutes, so a forwarded screenshot stops working.
 */
const LIVE_PREFIX = "l1";
export const LIVE_TOKEN_SECONDS = 120;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function key(): string {
  const secret = process.env.WORKER_TOKEN_SECRET;
  if (!secret || secret.length < 32) throw new ServiceUnavailableException("Card verification is not configured");
  return `card-qr:${secret}`;
}

const sign = (payload: string) => createHmac("sha256", key()).update(payload).digest("base64url").slice(0, 32);

export function issueLiveToken(publicId: string, now = Date.now()): { token: string; expiresAt: number } {
  const expiresAt = now + LIVE_TOKEN_SECONDS * 1000;
  const payload = `${publicId}.${Math.floor(expiresAt / 1000).toString(36)}`;
  return { token: `${LIVE_PREFIX}.${payload}.${sign(payload)}`, expiresAt };
}

/** The card's publicId and how it was presented, or null when the token is invalid or expired. */
export function resolveCardToken(token: string): { publicId: string; via: "PRINT" | "APP" } | null {
  const value = String(token || "").trim().toLowerCase();
  if (UUID.test(value)) return { publicId: value, via: "PRINT" };
  const [prefix, publicId, expiry, signature] = String(token || "").trim().split(".");
  if (prefix !== LIVE_PREFIX || !UUID.test(publicId || "") || !expiry || !signature) return null;
  const expected = Buffer.from(sign(`${publicId}.${expiry}`));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  if (parseInt(expiry, 36) * 1000 < Date.now()) return null;
  return { publicId, via: "APP" };
}
