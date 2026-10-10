import { CheckContract, fileRequest } from "../check-contract";

export const VOTER_OCR: CheckContract = {
  type: "VOTER_OCR",
  source: "https://e338ebdbb06e0ec4ec7d11b7a53702dc.apidog.io/voterid-upload-16301846e0",
  build: (input, files) => fileRequest("ocr/voter", input, files)
};
