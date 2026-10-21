/**
 * What each kind of viewer sees for a Liwip BGV card. The card belongs to the worker and
 * stays valid when they leave a partner.
 * - PUBLIC (anyone with the QR, and staff looking up another partner's worker): photo,
 *   name, card status, valid-until and which check categories passed. Never Aadhaar, PAN,
 *   address, date of birth, phone or provider results.
 * - VERIFIER: the public view plus the card number and each check's state and date.
 * - FULL: the partner's (or Keystone's) case detail, built by the cases service.
 */

const RUNNING = new Set(["PENDING", "QUEUED", "PROCESSING", "MANUAL_REVIEW"]);
const EXPIRING_DAYS = 30;

export type CardStatus = "valid" | "expiring" | "updating" | "expired" | "suspended";

export const CHECK_CATEGORY: Record<string, string> = {
  AADHAAR: "IDENTITY", PAN: "IDENTITY", VOTER_ID: "IDENTITY", PASSPORT: "IDENTITY", NAME_MATCH: "IDENTITY", MOBILE_NAME: "IDENTITY", EMAIL_CHECK: "IDENTITY",
  AADHAAR_OCR: "IDENTITY", PAN_OCR: "IDENTITY", VOTER_OCR: "IDENTITY", PASSPORT_OCR: "IDENTITY", AADHAAR_MASK: "IDENTITY",
  FACE_LIVENESS: "FACE", FACE_MATCH: "FACE",
  DRIVING_LICENSE: "DRIVING", LICENSE_OCR: "DRIVING", RC_FULL: "VEHICLE", RC_V2: "VEHICLE", VEHICLE_CHALLAN: "VEHICLE",
  CURRENT_ADDRESS: "ADDRESS", ADDRESS_MATCHING: "ADDRESS", DIGIPIN: "ADDRESS", ELECTRICITY_BILL: "ADDRESS",
  ECOURTS_SEARCH: "COURT_RECORDS", AML: "COURT_RECORDS", PEP: "COURT_RECORDS",
  EMPLOYMENT_HISTORY: "EMPLOYMENT", CURRENT_EMPLOYMENT: "EMPLOYMENT",
  EDUCATION: "EDUCATION", REFERENCE_CHECK: "REFERENCES", SKILL_CERTIFICATION: "SKILLS", DOCTOR_REGISTRATION: "SKILLS", ICSI: "SKILLS",
  CIBIL_SCORE: "FINANCIAL", EXPERIAN_REPORT: "FINANCIAL", CRIF_REPORT: "FINANCIAL", BANK_REPORT: "FINANCIAL", IFSC: "FINANCIAL", UPI: "FINANCIAL"
};
export const categoryOf = (type: string) => CHECK_CATEGORY[type] ?? "OTHER";

/** Admin panel state for a check status. */
export type CheckState = "WAITING" | "IN_PROGRESS" | "CLEAR" | "NEEDS_REVIEW" | "DISCREPANCY";
export function checkState(status: string): CheckState {
  switch (status) {
    case "VERIFIED": return "CLEAR";
    case "FAILED": return "DISCREPANCY";
    case "MANUAL_REVIEW": return "NEEDS_REVIEW";
    case "QUEUED": case "PROCESSING": return "IN_PROGRESS";
    default: return "WAITING";
  }
}

interface CheckRow { type: string; status: string; createdAt: Date; completedAt?: Date | null; updatedAt: Date }
interface CardRow { cardNumber: string; status: string; issuedAt: Date; expiresAt: Date }

/** Latest row per check type, in the order the checks were added. */
export function latestChecks<T extends CheckRow>(rows: T[]): T[] {
  const latest = new Map<string, T>();
  for (const row of [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) latest.set(row.type, row);
  return [...latest.values()];
}

export function cardStatus(card: Pick<CardRow, "status" | "expiresAt">, checks: Array<Pick<CheckRow, "status">>, now = Date.now()): CardStatus {
  if (card.status !== "ACTIVE") return "suspended";
  if (card.expiresAt.getTime() <= now) return "expired";
  if (checks.some((check) => RUNNING.has(check.status))) return "updating";
  if (card.expiresAt.getTime() - now < EXPIRING_DAYS * 86_400_000) return "expiring";
  return "valid";
}

/** A category passed when one of its checks cleared and none failed. */
export function passedCategories(checks: Array<Pick<CheckRow, "type" | "status">>): string[] {
  const passed = new Set<string>();
  const failed = new Set<string>();
  for (const check of checks) {
    if (check.status === "VERIFIED") passed.add(categoryOf(check.type));
    if (check.status === "FAILED") failed.add(categoryOf(check.type));
  }
  return [...passed].filter((category) => !failed.has(category)).sort();
}

export interface WorkerData { identity?: { fullName?: string }; personal?: { declaredName?: string; nameAsAadhaar?: string } }
export const workerName = (data: unknown) => {
  const value = (data ?? {}) as WorkerData;
  return value.identity?.fullName || value.personal?.declaredName || value.personal?.nameAsAadhaar || null;
};

export const photoDataUrl = (photo: { bytes: Uint8Array; contentType: string } | null) =>
  photo ? `data:${photo.contentType};base64,${Buffer.from(photo.bytes).toString("base64")}` : null;

export function publicCardView(input: { card: CardRow; checks: CheckRow[]; data: unknown; photo: string | null }) {
  const checks = latestChecks(input.checks);
  const status = cardStatus(input.card, checks);
  return {
    view: "PUBLIC" as const,
    valid: status === "valid" || status === "expiring" || status === "updating",
    status,
    name: workerName(input.data),
    photo: input.photo,
    validUntil: input.card.expiresAt.toISOString(),
    checksPassed: passedCategories(checks)
  };
}

export function verifierCardView(input: { card: CardRow; checks: CheckRow[]; data: unknown; photo: string | null }) {
  const checks = latestChecks(input.checks);
  return {
    ...publicCardView(input),
    view: "VERIFIER" as const,
    cardNumber: input.card.cardNumber,
    issuedAt: input.card.issuedAt.toISOString(),
    checks: checks.map((check) => ({
      type: check.type,
      category: categoryOf(check.type),
      state: checkState(check.status),
      verifiedAt: check.status === "VERIFIED" ? (check.completedAt ?? check.updatedAt).toISOString() : null
    }))
  };
}
