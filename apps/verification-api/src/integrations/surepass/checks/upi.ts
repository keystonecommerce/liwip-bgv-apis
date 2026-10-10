import { CheckContract, jsonRequest } from "../check-contract";

export const UPI: CheckContract = {
  type: "UPI",
  source: "https://e338ebdbb06e0ec4ec7d11b7a53702dc.apidog.io/upi-advanced-v2-16301801e0",
  build: input => jsonRequest("bank-verification/upi-advanced-v2", input, {"upiId":"upi_id"}, {}),
};
