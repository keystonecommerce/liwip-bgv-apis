import { CheckContract, fileRequest } from "../check-contract";

export const VOTER_OCR: CheckContract = {
  type: "VOTER_OCR",
  source: "https://app.surepass.app/docs/kyc/voterid-upload-16301846e0",
  build: (input, files) => fileRequest("ocr/voter", input, files)
};
