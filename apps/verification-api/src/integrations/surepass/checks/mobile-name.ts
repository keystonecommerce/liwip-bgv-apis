import { CheckContract, jsonRequest } from "../check-contract";

export const MOBILE_NAME: CheckContract = {
  type: "MOBILE_NAME",
  source: "https://app.surepass.app/docs/kyc/mobile-to-name-16301875e0",
  build: input => jsonRequest("mobile-to-name/verification", input, {"mobileNumber":"mobile_number"}, {}),
};
