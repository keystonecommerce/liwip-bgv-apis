import type { Verifier } from "../verifier";
import { verifyPassportDetails } from "../apis/verify-passport-details";
import { nameStatus } from "../verdicts";

export const PASSPORT: Verifier = {
  type: "PASSPORT",
  label: "Passport",
  call: (transport, payload) => verifyPassportDetails(transport, { fileNumber: String(payload.fileNumber), dob: String(payload.dob) }),
  verdict: (payload) => nameStatus(payload, ["full_name", "name"])
};
