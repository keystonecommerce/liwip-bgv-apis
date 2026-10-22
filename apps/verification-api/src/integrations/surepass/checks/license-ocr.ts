import { CheckContract, fileRequest } from "../check-contract";

export const LICENSE_OCR: CheckContract = {
  type: "LICENSE_OCR",
  source: "https://app.surepass.app/docs/kyc/license-upload-16301852e0",
  build: (input, files) => fileRequest("ocr/license", input, files)
};
