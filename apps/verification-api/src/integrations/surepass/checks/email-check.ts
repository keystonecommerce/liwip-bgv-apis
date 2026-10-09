import { CheckContract, jsonRequest } from "../check-contract";

export const EMAIL_CHECK: CheckContract = {
  type: "EMAIL_CHECK",
  source: "https://e338ebdbb06e0ec4ec7d11b7a53702dc.apidog.io/email-check-16302000e0",
  build: input => jsonRequest("employment/email-check", input, {"email":"email"}, {}),
};
