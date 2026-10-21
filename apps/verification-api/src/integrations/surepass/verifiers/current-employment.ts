import type { Verifier } from "../verifier";
import { verifyCurrentEmployment } from "../apis/verify-current-employment";

const optional = (value: unknown) => value ? String(value) : undefined;

/** Current employer by PAN, mobile or UAN. The result is always reviewed. */
export const CURRENT_EMPLOYMENT: Verifier = {
  type: "CURRENT_EMPLOYMENT",
  label: "Current Employment",
  call: (transport, payload) => verifyCurrentEmployment(transport, {
    panNumber: optional(payload.panNumber),
    mobileNumber: optional(payload.mobileNumber),
    uanNumber: optional(payload.uanNumber),
    employerName: optional(payload.employerName),
    employeeName: optional(payload.employeeName)
  })
};
