import type { Verifier } from "../verifier";
import { matchAddresses } from "../apis/match-addresses";

export const ADDRESS_MATCHING: Verifier = {
  type: "ADDRESS_MATCHING",
  label: "Address Matching",
  call: (transport, payload) => matchAddresses(transport, { address1: String(payload.address1), address2: String(payload.address2) }),
  verdict: () => (data) => data.match_status === true ? "verified" : data.match_status === false ? "failed" : "manual_review"
};
