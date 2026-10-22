import { CheckContract, fileRequest } from "../check-contract";

export const PAN_OCR: CheckContract = {
  type: "PAN_OCR",
  source: "https://app.surepass.app/docs/kyc/pan-upload-16301844e0",
  build: (input, files) => fileRequest("ocr/pan", input, files)
};
