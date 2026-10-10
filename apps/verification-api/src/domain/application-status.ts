import { ApplicationStatus, VerificationStatus } from "./verification.types";
/** No card until every required checkpoint has cleared; adverse findings take priority. */
export function applicationStatusForChecks(statuses: VerificationStatus[]): ApplicationStatus {
  if (!statuses.length) return "PENDING_VERIFICATION";
  if (statuses.includes("FAILED")) return "VERIFICATION_FAILED";
  if (statuses.includes("MANUAL_REVIEW")) return "MANUAL_REVIEW";
  if (statuses.every(value => value === "VERIFIED")) return "VERIFIED";
  if (statuses.every(value => value === "QUEUED" || value === "PENDING")) return "PENDING_VERIFICATION";
  return "VERIFICATION_IN_PROGRESS";
}
