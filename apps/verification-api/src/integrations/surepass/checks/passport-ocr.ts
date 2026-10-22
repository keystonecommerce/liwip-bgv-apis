import { CheckContract, fileRequest } from "../check-contract";

/** Indian passport (back page: file number, address, parents). */
export const PASSPORT_OCR: CheckContract = {
  type: "PASSPORT_OCR",
  source: "https://app.surepass.app/docs/kyc/passport-upload-16301854e0",
  build: (input, files) => fileRequest("ocr/passport", input, files)
};
