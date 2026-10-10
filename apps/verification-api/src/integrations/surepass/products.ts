import { UnrecoverableError } from "bullmq";
import type { VerificationType } from "../../domain/verification.types";

/**
 * Surepass products, by the "API value" slug the Surepass console shows. A
 * product must be enabled on the account before we call it, or the call fails
 * and may still cost credits.
 *
 * Defaults to what the sandbox account has active. Override per environment
 * with SUREPASS_ENABLED_PRODUCTS (comma-separated slugs).
 */
export const DEFAULT_ENABLED_PRODUCTS = [
  "aadhaar-ovse",
  "digilocker",
  "face-liveness",
  "face-match",
  "pan-comprehensive",
  "driving-license-text",
  "rc-v2",
  "rc-text",
  "voter-id-text",
  "passport-details",
  "employment-history-uan-v2",
  "eshram-verification",
  "ecourt-search-v2",
  "ecourt-individual-court-details",
  "ecourt-cnr-search-adv",
  "telecom-verification"
] as const;

/** Request path prefix → product slug. Every path the transport may call must be listed. */
const PATH_PRODUCTS: Array<[string, string]> = [
  ["/api/v1/aadhaar-v4/", "aadhaar-ovse"],
  ["/api/v1/digilocker/", "digilocker"],
  ["/api/v1/face/face-liveness", "face-liveness"],
  ["/api/v1/face/face-match", "face-match"],
  ["/api/v1/pan/pan-comprehensive", "pan-comprehensive"],
  ["/api/v1/driving-license/driving-license", "driving-license-text"],
  ["/api/v1/rc/rc-v2", "rc-v2"],
  ["/api/v1/rc/rc-full", "rc-text"],
  ["/api/v1/voter-id/voter-id", "voter-id-text"],
  ["/api/v1/passport/passport/passport-details", "passport-details"],
  ["/api/v1/income/employment-history-uan-v2", "employment-history-uan-v2"],
  ["/api/v1/eshram/", "eshram-verification"],
  ["/api/v1/ecourts/ecourt-search-v2", "ecourt-search-v2"],
  ["/api/v1/ecourts/ecourt-individual-court-details", "ecourt-individual-court-details"],
  ["/api/v1/ecourts/ecourt-cnr-search-adv", "ecourt-cnr-search-adv"],
  ["/api/v1/telecom/", "telecom-verification"]
];

/** Checks that call Surepass, and the product each one needs. Checks not listed are manual. */
const CHECK_PRODUCTS: Partial<Record<VerificationType, string>> = {
  PAN: "pan-comprehensive",
  DRIVING_LICENSE: "driving-license-text",
  RC_V2: "rc-v2",
  RC_FULL: "rc-text",
  VOTER_ID: "voter-id-text",
  PASSPORT: "passport-details",
  FACE_LIVENESS: "face-liveness",
  FACE_MATCH: "face-match",
  EMPLOYMENT_HISTORY: "employment-history-uan-v2",
  ECOURTS_SEARCH: "ecourt-search-v2"
};

const MANUAL_CHECKS = new Set<VerificationType>(["CURRENT_ADDRESS", "REFERENCE_CHECK", "SKILL_CERTIFICATION"]);

export function enabledProducts(): Set<string> {
  const configured = process.env.SUREPASS_ENABLED_PRODUCTS;
  const list = configured ? configured.split(",").map((item) => item.trim()).filter(Boolean) : DEFAULT_ENABLED_PRODUCTS;
  return new Set(list);
}

export function productForPath(pathname: string): string | undefined {
  return PATH_PRODUCTS.find(([prefix]) => pathname.startsWith(prefix))?.[1];
}

/** A check can run when it is manual or its Surepass product is enabled. */
export function isCheckAvailable(type: VerificationType): boolean {
  if (MANUAL_CHECKS.has(type)) return true;
  const product = CHECK_PRODUCTS[type];
  return Boolean(product && enabledProducts().has(product));
}

/** Refuse before dispatch, so a disabled product never reaches Surepass. */
export function assertProductEnabled(pathname: string): void {
  const product = productForPath(pathname);
  if (!product || !enabledProducts().has(product)) {
    throw Object.assign(new UnrecoverableError(`Surepass product ${product || pathname} is not enabled for this account`), { code: "PROVIDER_PRODUCT_DISABLED" });
  }
}
