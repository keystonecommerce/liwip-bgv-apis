import { CheckContract, jsonRequest } from "../check-contract";

/** Credit-bureau profile linked to a mobile number (name, date of birth, addresses, ID numbers). Evidence only. */
export const PREFILL_BY_MOBILE: CheckContract = {
  type: "PREFILL_BY_MOBILE",
  source: "https://app.surepass.app/docs/kyc/prefill-by-mobile-16301937e0",
  build: input => jsonRequest("prefill/prefill-by-mobile", input, {"mobile":"mobile"})
};
