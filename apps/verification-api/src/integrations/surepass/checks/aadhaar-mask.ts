import { CheckContract, fileRequest } from "../check-contract";

export const AADHAAR_MASK: CheckContract = {
  type: "AADHAAR_MASK",
  source: "https://app.surepass.app/docs/kyc/aadhaar-masking-16301843e0",
  build: (input, files) => fileRequest("ocr/mask-aadhaar", input, files)
};
