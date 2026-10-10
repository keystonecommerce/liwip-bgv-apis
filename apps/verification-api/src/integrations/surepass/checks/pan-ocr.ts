import { CheckContract, fileRequest } from "../check-contract";

export const PAN_OCR: CheckContract = {
  type: "PAN_OCR",
  source: "https://e338ebdbb06e0ec4ec7d11b7a53702dc.apidog.io/pan-upload-16301844e0",
  build: (input, files) => fileRequest("ocr/pan", input, files)
};
