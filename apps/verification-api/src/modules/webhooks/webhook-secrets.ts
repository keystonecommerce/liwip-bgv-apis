import { ServiceUnavailableException } from "@nestjs/common";
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";

/**
 * Webhook signing secrets. We sign every delivery, so the secret is kept, encrypted with
 * AES-256-GCM under WEBHOOK_SECRET_KEY (32 bytes, base64). Outside production a key derived from
 * ADMIN_AUTH_SECRET stands in, so development needs no extra setting.
 */
function key(): Buffer {
  const configured = String(process.env.WEBHOOK_SECRET_KEY || "").trim();
  if (configured) {
    const bytes = Buffer.from(configured, "base64");
    if (bytes.length !== 32) throw new ServiceUnavailableException("WEBHOOK_SECRET_KEY must be 32 bytes, base64-encoded");
    return bytes;
  }
  const fallback = String(process.env.ADMIN_AUTH_SECRET || "");
  if (process.env.NODE_ENV === "production" || !fallback) throw new ServiceUnavailableException("Webhooks are not configured (WEBHOOK_SECRET_KEY)");
  return createHash("sha256").update(`liwip-webhook-secrets:${fallback}`).digest();
}

export const newWebhookSecret = () => `whsec_${randomBytes(32).toString("base64url")}`;

export function encryptSecret(secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), body.toString("base64url")].join(".");
}

export function decryptSecret(stored: string): string {
  const [version, iv, tag, body] = stored.split(".");
  if (version !== "v1" || !iv || !tag || !body) throw new Error("Unreadable webhook secret");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
}

/**
 * `Liwip-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">`. Receivers recompute
 * it with their secret and reject old timestamps (we suggest five minutes).
 */
export function signatureHeader(secret: string, body: string, at = new Date()): string {
  const timestamp = Math.floor(at.getTime() / 1000);
  return `t=${timestamp},v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}
