import { explainResult, onFailFor, rulesOf } from "../../domain/final-result";
import { moduleOf, modulesOf, subjectOf } from "../../domain/modules";
import { categoryOf, checkState, workerName } from "../cards/card-views";
import { maskPhone } from "../admin-panel/input";

/** Bumped when a field changes meaning or goes away; new fields keep the version. */
export const REPORT_VERSION = 1;

export interface ReportCheck {
  id: string; type: string; status: string; failureReason: string | null; createdAt: Date | string; completedAt: Date | string | null; updatedAt: Date | string;
  result?: unknown;
  fieldVisit?: { outcome: string | null; submittedAt: Date | null; evidenceCount: number } | null;
}

export interface ReportInput {
  id: string;
  status: string;
  createdAt: Date;
  finalResultAt: Date | null;
  partner: { id: string; name: string };
  program: { id: string; name: string };
  package: { code: string; name: string; version: number; checks: unknown } | null;
  data: unknown;
  workerPhone: string | null;
  checks: ReportCheck[];
  card: { cardNumber: string; status: string; issuedAt: Date | string; expiresAt: Date | string } | null;
  /** Set when a partner sees the case as it was when the person's relationship ended. */
  asOf?: Date | null;
}

const iso = (value: Date | string | null | undefined) => (value ? new Date(value).toISOString() : null);

// What a reviewer or the check wrote about the outcome, never raw provider data.
function noteOf(check: ReportCheck): string | null {
  if (check.failureReason) return check.failureReason;
  const result = (check.result ?? {}) as { reviewNote?: unknown; reason?: unknown };
  if (typeof result.reviewNote === "string" && result.reviewNote.trim()) return result.reviewNote.trim();
  if (check.status === "MANUAL_REVIEW" && typeof result.reason === "string" && result.reason.trim()) return result.reason.trim();
  return null;
}

/**
 * The case report as JSON: the final result and why, who or what was verified, and each module's
 * checks with their outcome. It carries the person's name and the last four digits of their phone,
 * never ID numbers, documents or provider responses. (PDF and Excel wait on decision D6.)
 */
export function buildCaseReport(input: ReportInput, now = new Date()) {
  // The latest row per check type, in the order the checks were added.
  const ordered = [...input.checks].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  const checks = [...new Map(ordered.map((check) => [check.type, check])).values()];
  const rules = rulesOf(input.package?.checks);
  const explained = explainResult(checks, rules);
  const types = checks.map((check) => check.type);
  const subject = subjectOf(types, input.data);
  return {
    reportVersion: REPORT_VERSION,
    generatedAt: now.toISOString(),
    asOf: iso(input.asOf),
    case: {
      id: input.id,
      status: input.status,
      partner: input.partner,
      program: input.program,
      package: input.package ? { code: input.package.code, name: input.package.name, version: input.package.version } : null,
      openedAt: input.createdAt.toISOString(),
      completedAt: explained ? iso(input.finalResultAt) : null
    },
    result: {
      final: explained?.result ?? null,
      because: (explained?.because ?? []).map((item) => ({ check: item.type, status: item.status, effect: item.effect }))
    },
    subject: {
      person: subject.person ? { name: workerName(input.data), phoneLast4: maskPhone(input.workerPhone) } : null,
      vehicle: subject.vehicle
    },
    sections: modulesOf(types).map((module) => ({
      module,
      checks: checks.filter((check) => moduleOf(check.type) === module).map((check) => {
        const rule = rules.find((item) => item.type === check.type);
        return {
          id: check.id,
          type: check.type,
          category: categoryOf(check.type),
          required: rule ? rule.mode !== "OPTIONAL" : true,
          onFail: onFailFor(check.type, rules),
          status: check.status,
          state: checkState(check.status),
          note: noteOf(check),
          completedAt: iso(check.completedAt),
          ...(check.fieldVisit ? { fieldVisit: { outcome: check.fieldVisit.outcome, submittedAt: iso(check.fieldVisit.submittedAt), evidenceCount: check.fieldVisit.evidenceCount } } : {})
        };
      })
    })),
    card: input.card ? { cardNumber: input.card.cardNumber, status: input.card.status, issuedAt: iso(input.card.issuedAt), validUntil: iso(input.card.expiresAt) } : null
  };
}
