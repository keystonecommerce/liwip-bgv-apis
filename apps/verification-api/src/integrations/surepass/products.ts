import { UnrecoverableError } from "bullmq";
import type { VerificationType } from "../../domain/verification.types";

/**
 * Surepass products, by the slug the Surepass dashboard path ends in (e.g.
 * `identity/rc-text` → `rc-text`). A product must be enabled on the account before
 * we call it, or the call fails and may still cost credits.
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

/**
 * Request path → product slug. Every path the transport may call must be listed.
 * A path ending in "/" covers everything under it; any other path must match exactly
 * (a trailing slash on the request is ignored).
 */
const PATH_PRODUCTS: Array<[string, string]> = [
  ["/api/v1/aadhaar-v4/", "aadhaar-ovse"],
  ["/api/v1/digilocker/", "digilocker"],
  ["/api/v1/face/face-liveness", "face-liveness"],
  ["/api/v1/face/face-match", "face-match"],
  ["/api/v1/pan/pan-comprehensive", "pan-comprehensive"],
  ["/api/v1/driving-license/driving-license", "driving-license-text"],
  ["/api/v1/rc/rc-v2", "rc-v2"],
  ["/api/v1/rc/rc-full", "rc-text"],
  ["/api/v1/rc/rc-related/challan-advanced", "rc-challan-advanced"],
  ["/api/v1/voter-id/voter-id", "voter-id-text"],
  ["/api/v1/passport/passport/passport-details", "passport-details"],
  ["/api/v1/income/employment-history-uan-v2", "employment-history-uan-v2"],
  ["/api/v1/eshram/", "eshram-verification"],
  ["/api/v1/ecourts/ecourt-search-v2", "ecourt-search-v2"],
  ["/api/v1/ecourts/ecourt-individual-court-details", "ecourt-individual-court-details"],
  ["/api/v1/ecourts/ecourt-cnr-search-adv", "ecourt-cnr-search-adv"],
  ["/api/v1/telecom/", "telecom-verification"],
  ["/api/v1/utility/electricity", "electricity"],
  ["/api/v1/utility/electricity/operator-code-list", "electricity"],
  ["/api/v1/ocr/aadhaar", "ocr-aadhaar"],
  ["/api/v1/ocr/aadhaar-full", "ocr-aadhaar-full"],
  ["/api/v1/ocr/mask-aadhaar", "ocr-aadhaar-masking"],
  ["/api/v1/ocr/pan", "ocr-pan"],
  ["/api/v1/ocr/license", "ocr-license"],
  ["/api/v1/ocr/passport", "ocr-passport"],
  ["/api/v1/utils/name-matching", "name-match"],
  ["/api/v1/mobile-to-name/verification", "mobile-to-name"],
  ["/api/v1/prefill/prefill-by-mobile", "prefill-by-mobile"],
  ["/api/v1/employment/email-check", "email-check"],
  ["/api/v1/bank-verification", "bank-verification"],
  ["/api/v1/bank-verification/upi-verification", "bank-verification-upi"]
];

/**
 * Checks that call Surepass, and the products that can serve each one. Any one
 * enabled product is enough. Checks not listed are manual.
 */
const CHECK_PRODUCTS: Partial<Record<VerificationType, readonly string[]>> = {
  AADHAAR: ["digilocker", "aadhaar-ovse"],
  PAN: ["pan-comprehensive"],
  DRIVING_LICENSE: ["driving-license-text"],
  // The vehicle check uses RC V2 when enabled, else RC Text (the same fields).
  RC_V2: ["rc-v2", "rc-text"],
  RC_FULL: ["rc-text"],
  VOTER_ID: ["voter-id-text"],
  PASSPORT: ["passport-details"],
  FACE_LIVENESS: ["face-liveness"],
  FACE_MATCH: ["face-match"],
  EMPLOYMENT_HISTORY: ["employment-history-uan-v2"],
  ECOURTS_SEARCH: ["ecourt-search-v2"],
  VEHICLE_CHALLAN: ["rc-challan-advanced"],
  ELECTRICITY_BILL: ["electricity"]
};

const MANUAL_CHECKS = new Set<VerificationType>(["CURRENT_ADDRESS", "REFERENCE_CHECK", "SKILL_CERTIFICATION"]);

export function enabledProducts(): Set<string> {
  const configured = process.env.SUREPASS_ENABLED_PRODUCTS;
  const list = configured ? configured.split(",").map((item) => item.trim()).filter(Boolean) : DEFAULT_ENABLED_PRODUCTS;
  return new Set(list);
}

export function productForPath(pathname: string): string | undefined {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return PATH_PRODUCTS.find(([entry]) => entry.endsWith("/") ? pathname.startsWith(entry) : path === entry)?.[1];
}

/** A check can run when it is manual or one of its Surepass products is enabled. */
export function isCheckAvailable(type: VerificationType): boolean {
  if (MANUAL_CHECKS.has(type)) return true;
  const enabled = enabledProducts();
  return (CHECK_PRODUCTS[type] ?? []).some((product) => enabled.has(product));
}

/** Every check type this platform can run today: Surepass checks whose product is enabled, and manual checks. */
export function availableCheckTypes(): VerificationType[] {
  return [...(Object.keys(CHECK_PRODUCTS) as VerificationType[]), ...MANUAL_CHECKS].filter(isCheckAvailable);
}

/** Refuse before dispatch, so a disabled product never reaches Surepass. */
export function assertProductEnabled(pathname: string): void {
  const product = productForPath(pathname);
  if (!product || !enabledProducts().has(product)) {
    throw Object.assign(new UnrecoverableError(`Surepass product ${product || pathname} is not enabled for this account`), { code: "PROVIDER_PRODUCT_DISABLED" });
  }
}
