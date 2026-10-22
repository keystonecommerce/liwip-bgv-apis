import { CheckContract, fileRequest } from "../check-contract";

export const AADHAAR_OCR: CheckContract = {
  type: "AADHAAR_OCR",
  source: "https://app.surepass.app/docs/kyc/aadhaar-upload-16301842e0",
  build: (input, files) => fileRequest("ocr/aadhaar", input, files)
};
