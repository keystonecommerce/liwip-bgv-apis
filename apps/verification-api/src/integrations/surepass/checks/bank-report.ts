import { CheckContract, jsonRequest } from "../check-contract";

export const BANK_REPORT: CheckContract = {
  type: "BANK_REPORT",
  source: "https://e338ebdbb06e0ec4ec7d11b7a53702dc.apidog.io/bank-verification-pdf-report-16747467e0",
  build: input => jsonRequest("bank-verification/bank-verification-pdf-report", input, {"accountNumber":"id_number","ifsc":"ifsc"}, {"ifsc_details":true}),
};
