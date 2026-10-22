import type { Verifier } from "../verifier";
import { verifyRcFull } from "../apis/verify-rc-full";

/** Legacy RC Full lookup, kept for comparison. The result is always reviewed. */
export const RC_FULL: Verifier = {
  type: "RC_FULL",
  label: "RC Full",
  call: (transport, payload) => verifyRcFull(transport, { idNumber: String(payload.idNumber) })
};
