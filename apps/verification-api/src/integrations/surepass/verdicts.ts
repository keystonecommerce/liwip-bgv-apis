import { isoDate } from "../../domain/dates";
import { matchesAnyName } from "../../domain/name-match";
import type { ProviderResponse } from "../verification-provider";

export type CheckStatus = NonNullable<ProviderResponse["status"]>;
/** Turns a successful response's data into a check status. */
export type Verdict = (data: Record<string, unknown>) => CheckStatus;

/**
 * A successful lookup only proves the document exists. It passes when the name on
 * record matches one of the worker's official names; anything else goes to a reviewer.
 * - `official: false` (no verified Aadhaar or PAN yet): always review.
 * - `dobConfirmed`: the registry found the record with the official date of birth, so
 *   sharing one full word with an official name is enough.
 * - `dobField`: the registry returns a date of birth; it must equal `anchorDob`, and when
 *   it does the looser name rule applies.
 */
export function nameStatus(payload: Record<string, unknown>, returned: string[], options: { dobField?: string; strict?: boolean } = {}): Verdict {
  const expected = payload.name;
  const references = (Array.isArray(expected) ? expected : [expected]).filter((name) => typeof name === "string" && name.trim());
  return (data) => {
    if (payload.official === false || !references.length) return "manual_review";
    const got = returned.map((field) => data[field]).find((value) => typeof value === "string" && value.trim());
    if (!got) return "manual_review";
    let dobConfirmed = payload.dobConfirmed === true;
    if (options.dobField) {
      const onRecord = isoDate(data[options.dobField]);
      const anchor = isoDate(payload.anchorDob);
      if (onRecord && anchor) {
        if (onRecord !== anchor) return "manual_review";
        dobConfirmed = true;
      }
    }
    return matchesAnyName(got, references, { loose: dobConfirmed && !options.strict }) ? "verified" : "manual_review";
  };
}

export function isPastDate(value: unknown): boolean {
  if (typeof value !== "string" || !value) return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.getTime() < Date.now();
}
