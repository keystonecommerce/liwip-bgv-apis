import { CheckContract, jsonRequest } from "../check-contract";

export const EMAIL_CHECK: CheckContract = {
  type: "EMAIL_CHECK",
  source: "https://app.surepass.app/docs/kyc/email-check-16302000e0",
  build: input => jsonRequest("employment/email-check", input, {"email":"email"}, {}),
};
