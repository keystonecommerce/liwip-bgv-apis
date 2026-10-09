import { CheckContract, fileRequest } from "../check-contract";

export const PASSPORT_OCR: CheckContract = {
  type: "PASSPORT_OCR",
  source: "https://e338ebdbb06e0ec4ec7d11b7a53702dc.apidog.io/international-passport-upload-16301855e0",
  build: (input, files) => fileRequest("ocr/international-passport", input, files)
};
