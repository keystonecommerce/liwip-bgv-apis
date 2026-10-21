import { CheckContract, jsonRequest } from "../check-contract";

/** A missing account fails; an existing one still needs its holder name compared. */
export function accountStatus(data: Record<string, unknown>) {
  return data.account_exists === false ? "failed" as const : "manual_review" as const;
}

/** Penny-drop verification: confirms the account exists and returns the holder name. */
export const BANK_ACCOUNT: CheckContract = {
  type: "BANK_ACCOUNT",
  source: "https://app.surepass.app/docs/kyc/bank-verification-16301795e0",
  build: input => jsonRequest("bank-verification/", input, {"accountNumber":"id_number","ifsc":"ifsc"}, {"ifsc_details":true}),
  status: accountStatus
};
