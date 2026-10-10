import { CheckContract, jsonRequest } from "../check-contract";

export const AML: CheckContract = {
  type: "AML",
  source: "https://e338ebdbb06e0ec4ec7d11b7a53702dc.apidog.io/aml-search-18264522e0",
  build: input => jsonRequest("aml/aml-search", input, {"name":"name","dob":"dob","nationality":"nationality","address":"address"}, {}),
};
