import { CheckContract, jsonRequest } from "../check-contract";

export const ICSI: CheckContract = {
  type: "ICSI",
  source: "https://e338ebdbb06e0ec4ec7d11b7a53702dc.apidog.io/icsi-16301833e0",
  build: input => jsonRequest("corporate/icsi", input, {"membershipNumber":"membership_number"}, {}),
};
