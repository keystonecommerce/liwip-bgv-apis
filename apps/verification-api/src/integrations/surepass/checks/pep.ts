import { CheckContract, jsonRequest } from "../check-contract";

export const PEP: CheckContract = {
  type: "PEP",
  source: "https://app.surepass.app/docs/kyc/pep-match-16302007e0",
  build: input => jsonRequest("pep/match", input, {"name":"name","dob":"dob","nationality":"nationality","address":"address"}, {}),
};
