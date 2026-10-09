import { CheckContract, fileRequest } from "../check-contract";

export const LICENSE_OCR: CheckContract = {
  type: "LICENSE_OCR",
  source: "https://e338ebdbb06e0ec4ec7d11b7a53702dc.apidog.io/license-upload-16301852e0",
  build: (input, files) => fileRequest("ocr/license", input, files)
};
