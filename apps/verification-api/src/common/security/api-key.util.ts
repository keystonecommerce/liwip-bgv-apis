import { createHash, randomBytes } from "node:crypto";

/** Every scope the platform API currently understands. */
export const ALL_SCOPES = [
  "packages:read",
  "applications:write",
  "applications:read",
  "verifications:retry",
  "verifications:review",
  "digilocker:write",
  "aadhaar:write",
  "aadhaar:read",
  "otp:write",
  "documents:write",
  "documents:read",
  "audit:read",
] as const;

export type Scope = (typeof ALL_SCOPES)[number];

/**
 * Least-privilege default when no scopes are specified at key creation. An
 * operator omission must NOT silently mint an all-access key — they have to opt
 * into privileged scopes explicitly.
 */
export const DEFAULT_SCOPES: string[] = ["packages:read"];

/**
 * Mint a fresh partner API key. The raw value is returned ONCE for handover;
 * only the SHA-256 hash and a short prefix are ever persisted.
 */
export function generateApiKey(): { raw: string; keyHash: string; keyPrefix: string } {
  const raw = `gv_${randomBytes(32).toString("base64url")}`;
  const keyHash = createHash("sha256").update(raw).digest("hex");
  return { raw, keyHash, keyPrefix: raw.slice(0, 10) };
}

/** Validate a requested scope list against the known set; throws on unknown.
 *  When none are given, defaults to the minimal least-privilege set. */
export function normalizeScopes(input: string[] | undefined): string[] {
  if (!input || input.length === 0) return [...DEFAULT_SCOPES];
  const known = new Set<string>(ALL_SCOPES);
  const cleaned = input.map((s) => s.trim()).filter(Boolean);
  const unknown = cleaned.filter((s) => !known.has(s));
  if (unknown.length) {
    throw new Error(`Unknown scope(s): ${unknown.join(", ")}. Valid scopes: ${ALL_SCOPES.join(", ")}`);
  }
  return Array.from(new Set(cleaned));
}
