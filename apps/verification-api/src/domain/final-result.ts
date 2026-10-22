/**
 * A case's final result: PASS, FAIL or REVIEW, once no check is waiting or running.
 *
 * Each package check says what its failure means (`onFail`): FAIL the case, send it to REVIEW,
 * or IGNORE it. Required checks default to FAIL and optional ones to REVIEW. A check in review
 * makes the case REVIEW. FAIL wins over REVIEW, REVIEW over PASS. Checks the package does not
 * list (a worker's own choices, extras bought later) count as required.
 */
export const FINAL_RESULTS = ["PASS", "FAIL", "REVIEW"] as const;
export type FinalResult = (typeof FINAL_RESULTS)[number];
export const ON_FAIL = ["FAIL", "REVIEW", "IGNORE"] as const;
export type OnFail = (typeof ON_FAIL)[number];

export interface ResultRule { type: string; mode?: string; onFail?: string }
export interface ResultCheck { type: string; status: string }

const WAITING = new Set(["PENDING", "QUEUED", "PROCESSING"]);

/** What a failure of this check does to the case. */
export function onFailFor(type: string, rules: readonly ResultRule[]): OnFail {
  const rule = rules.find((item) => item.type === type);
  if (rule?.onFail && (ON_FAIL as readonly string[]).includes(rule.onFail)) return rule.onFail as OnFail;
  return rule?.mode === "OPTIONAL" ? "REVIEW" : "FAIL";
}

/** The result and the checks behind it, or null while a check is still waiting or running. */
export function explainResult(checks: readonly ResultCheck[], rules: readonly ResultRule[]): { result: FinalResult; because: Array<{ type: string; status: string; effect: "FAIL" | "REVIEW" }> } | null {
  if (!checks.length || checks.some((check) => WAITING.has(check.status))) return null;
  const because: Array<{ type: string; status: string; effect: "FAIL" | "REVIEW" }> = [];
  for (const check of checks) {
    if (check.status === "MANUAL_REVIEW") because.push({ type: check.type, status: check.status, effect: "REVIEW" });
    if (check.status === "FAILED") {
      const effect = onFailFor(check.type, rules);
      if (effect !== "IGNORE") because.push({ type: check.type, status: check.status, effect });
    }
  }
  if (because.some((item) => item.effect === "FAIL")) return { result: "FAIL", because: because.filter((item) => item.effect === "FAIL") };
  if (because.length) return { result: "REVIEW", because };
  return { result: "PASS", because: [] };
}

export const finalResultFor = (checks: readonly ResultCheck[], rules: readonly ResultRule[]): FinalResult | null => explainResult(checks, rules)?.result ?? null;

/** The package's checks as result rules (the JSON stored on VerificationPackage.checks). */
export function rulesOf(packageChecks: unknown): ResultRule[] {
  return Array.isArray(packageChecks) ? packageChecks.filter((item): item is ResultRule => typeof item?.type === "string") : [];
}
