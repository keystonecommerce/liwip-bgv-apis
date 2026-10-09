import { CheckContract, fileRequest } from "../check-contract";

export const AADHAAR_MASK: CheckContract = {
  type: "AADHAAR_MASK",
  source: "https://e338ebdbb06e0ec4ec7d11b7a53702dc.apidog.io/aadhaar-masking-16301843e0",
  build: (input, files) => fileRequest("ocr/mask-aadhaar", input, files)
};
