import type { Verifier } from "../verifier";
import { verifyEmploymentHistory } from "../apis/verify-employment-history";

/** UAN employment history. The result is always reviewed. */
export const EMPLOYMENT_HISTORY: Verifier = {
  type: "EMPLOYMENT_HISTORY",
  label: "Employment History",
  call: (transport, payload) => verifyEmploymentHistory(transport, { uan: String(payload.uan) })
};
