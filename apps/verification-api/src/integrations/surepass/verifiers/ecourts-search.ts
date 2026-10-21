import type { Verifier } from "../verifier";
import { searchEcourts } from "../apis/search-ecourts";

/** No cases passes. Any match is a possible match for a reviewer, never a failure by itself. */
export const ECOURTS_SEARCH: Verifier = {
  type: "ECOURTS_SEARCH",
  label: "Court Records",
  call: (transport, payload) => searchEcourts(transport, {
    name: String(payload.name),
    fatherName: String(payload.fatherName),
    address: String(payload.address),
    year: payload.year ? String(payload.year) : undefined,
    state: payload.state ? String(payload.state) : undefined
  }),
  verdict: () => (data) => Array.isArray(data.result) ? (data.result.length > 0 ? "manual_review" : "verified") : "manual_review"
};
