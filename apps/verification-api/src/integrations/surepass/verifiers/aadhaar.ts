import type { Verifier } from "../verifier";
import { verifyEaadhaar } from "../apis/verify-eaadhaar";

/** e-Aadhaar PDF upload. The result is always reviewed. */
export const AADHAAR: Verifier = {
  type: "AADHAAR",
  label: "e-Aadhaar",
  call: (transport, payload) => verifyEaadhaar(transport, payload as unknown as Parameters<typeof verifyEaadhaar>[1])
};
