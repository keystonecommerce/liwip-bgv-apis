import { CheckContract, fileRequest } from "../check-contract";

export const AADHAAR_OCR: CheckContract = {
  type: "AADHAAR_OCR",
  source: "https://e338ebdbb06e0ec4ec7d11b7a53702dc.apidog.io/aadhaar-upload-16301842e0",
  build: (input, files) => fileRequest("ocr/aadhaar", input, files)
};
