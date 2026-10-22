import { CheckContract, jsonRequest } from "../check-contract";

/** Name and address on an electricity connection. The bill is often in a family member's name, so it is reviewed. */
export const ELECTRICITY_BILL: CheckContract = {
  type: "ELECTRICITY_BILL",
  source: "https://app.surepass.app/docs/kyc/electricity-bill-details-16301883e0",
  build: input => jsonRequest("utility/electricity/", input, {"consumerNumber":"id_number","operatorCode":"operator_code"})
};
