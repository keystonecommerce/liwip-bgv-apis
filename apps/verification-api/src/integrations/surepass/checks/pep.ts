import { CheckContract, jsonRequest } from "../check-contract";

export const PEP: CheckContract = {
  type: "PEP",
  source: "https://e338ebdbb06e0ec4ec7d11b7a53702dc.apidog.io/pep-match-16302007e0",
  build: input => jsonRequest("pep/match", input, {"name":"name","dob":"dob","nationality":"nationality","address":"address"}, {}),
};
