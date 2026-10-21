import { CheckContract, jsonRequest } from "../check-contract";

/** Challans settled or closed; anything else (pending, in court) is for a reviewer to weigh. */
const SETTLED = /^(paid|disposed|closed|settled)$/i;

/** No open challans passes. Open challans are a risk signal, never a failure by themselves. */
export function challanStatus(data: Record<string, unknown>) {
  const challans = data.challan_details;
  if (!Array.isArray(challans)) return "manual_review" as const;
  const open = challans.filter((item) => !SETTLED.test(String((item as Record<string, unknown>)?.challan_status ?? "").trim()));
  return open.length ? "manual_review" as const : "verified" as const;
}

export const VEHICLE_CHALLAN: CheckContract = {
  type: "VEHICLE_CHALLAN",
  source: "https://app.surepass.app/docs/kyc/rc-challan-advanced-17209625e0",
  build: input => jsonRequest("rc/rc-related/challan-advanced", input, {"registrationNumber":"rc_number"}),
  status: challanStatus
};
