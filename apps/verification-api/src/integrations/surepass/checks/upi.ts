import { CheckContract, jsonRequest } from "../check-contract";
import { accountStatus } from "./bank-account";

export const UPI: CheckContract = {
  type: "UPI",
  source: "https://app.surepass.app/docs/kyc/upi-verification-16301800e0",
  build: input => jsonRequest("bank-verification/upi-verification", input, {"upiId":"upi_id"}),
  status: accountStatus
};
