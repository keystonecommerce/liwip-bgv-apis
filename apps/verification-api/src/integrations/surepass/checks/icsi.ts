import { CheckContract, jsonRequest } from "../check-contract";

export const ICSI: CheckContract = {
  type: "ICSI",
  source: "https://app.surepass.app/docs/kyc/icsi-16301833e0",
  build: input => jsonRequest("corporate/icsi", input, {"membershipNumber":"membership_number"}, {}),
};
