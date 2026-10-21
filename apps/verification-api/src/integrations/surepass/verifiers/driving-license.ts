import type { Verifier } from "../verifier";
import { verifyDrivingLicense } from "../apis/verify-driving-license";
import { isPastDate, nameStatus } from "../verdicts";

/** An expired licence goes to review whatever the name. */
export const DRIVING_LICENSE: Verifier = {
  type: "DRIVING_LICENSE",
  label: "Driving Licence",
  call: (transport, payload) => verifyDrivingLicense(transport, { idNumber: String(payload.licenseNumber), dob: String(payload.dob) }),
  verdict: (payload) => (data) => isPastDate(data.doe) ? "manual_review" : nameStatus(payload, ["name"])(data)
};
