import type { Verifier } from "../verifier";
import { verifyPanComprehensive } from "../apis/verify-pan-comprehensive";
import { nameStatus } from "../verdicts";

export const PAN: Verifier = {
  type: "PAN",
  label: "PAN",
  call: (transport, payload) => verifyPanComprehensive(transport, { idNumber: String(payload.idNumber) }),
  verdict: (payload) => nameStatus(payload, ["full_name", "name"], { dobField: "dob" })
};
