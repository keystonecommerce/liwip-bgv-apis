import type { Verifier } from "../verifier";
import { verifyVoterId } from "../apis/verify-voter-id";
import { nameStatus } from "../verdicts";

export const VOTER_ID: Verifier = {
  type: "VOTER_ID",
  label: "Voter ID",
  call: (transport, payload) => verifyVoterId(transport, {
    idNumber: String(payload.idNumber),
    // Surepass takes one name; matching below accepts any reference name.
    fullName: String(Array.isArray(payload.fullName) ? payload.fullName[0] ?? "" : payload.fullName),
    dob: String(payload.dob)
  }),
  verdict: (payload) => nameStatus({ ...payload, name: payload.fullName }, ["name", "name_on_card"])
};
