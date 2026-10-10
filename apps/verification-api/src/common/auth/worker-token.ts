import { ServiceUnavailableException } from "@nestjs/common";
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Proof that a worker passed OTP for a phone, issued to one platform. A platform
 * API key alone cannot open a worker's case; it also needs this token.
 */
export interface WorkerIdentity {
  tenantId: string;
  clientId: string;
  /** Normalised 91XXXXXXXXXX. */
  phone: string;
  expiresAt: number;
}

const VERSION = "w1";
const TTL_SECONDS = 12 * 60 * 60;

function secret(): string {
  const value = process.env.WORKER_TOKEN_SECRET;
  if (!value || value.length < 32) throw new ServiceUnavailableException("Worker sessions are not configured");
  return value;
}

const sign = (payload: string) => createHmac("sha256", secret()).update(`${VERSION}.${payload}`).digest("base64url");

export function issueWorkerToken(identity: Omit<WorkerIdentity, "expiresAt">): { token: string; expiresAt: number } {
  const expiresAt = Date.now() + TTL_SECONDS * 1000;
  const payload = Buffer.from(JSON.stringify({ ...identity, expiresAt })).toString("base64url");
  return { token: `${VERSION}.${payload}.${sign(payload)}`, expiresAt };
}

export function readWorkerToken(token: string | undefined): WorkerIdentity | null {
  const [version, payload, supplied] = (token || "").split(".");
  if (version !== VERSION || !payload || !supplied) return null;
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(supplied);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Partial<WorkerIdentity>;
    if (!value.tenantId || !value.clientId || !/^91[6-9]\d{9}$/.test(value.phone || "") || !value.expiresAt || value.expiresAt < Date.now()) return null;
    return value as WorkerIdentity;
  } catch {
    return null;
  }
}
