import { CheckContract, fileRequest } from "../check-contract";

/** Both sides of an Aadhaar card: name, date of birth, address and care-of. */
export const AADHAAR_OCR_FULL: CheckContract = {
  type: "AADHAAR_OCR_FULL",
  source: "https://app.surepass.app/docs/kyc/aadhaar-full-41796949e0",
  build: (input, files) => fileRequest("ocr/aadhaar-full", input, files)
};
