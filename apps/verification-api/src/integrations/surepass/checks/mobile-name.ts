import { CheckContract, jsonRequest } from "../check-contract";

export const MOBILE_NAME: CheckContract = {
  type: "MOBILE_NAME",
  source: "https://e338ebdbb06e0ec4ec7d11b7a53702dc.apidog.io/mobile-to-name-16301875e0",
  build: input => jsonRequest("mobile-to-name/verification", input, {"mobileNumber":"mobile_number"}, {}),
};
