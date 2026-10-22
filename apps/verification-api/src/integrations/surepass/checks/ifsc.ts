import { CheckContract, jsonRequest } from "../check-contract";

export const IFSC: CheckContract = {
  type: "IFSC",
  source: "https://app.surepass.app/docs/kyc/find-ifsc-21614132e0",
  build: input => jsonRequest("bank-verification/find-ifsc", input, {"ifsc":"ifsc"}, {}),
  status: data => data.exists === true ? "verified" : data.exists === false ? "failed" : "manual_review",
};
