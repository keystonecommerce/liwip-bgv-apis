import { CheckContract, jsonRequest } from "../check-contract";

export const AML: CheckContract = {
  type: "AML",
  source: "https://app.surepass.app/docs/kyc/aml-search-18264522e0",
  build: input => jsonRequest("aml/aml-search", input, {"name":"name","dob":"dob","nationality":"nationality","address":"address"}, {}),
};
