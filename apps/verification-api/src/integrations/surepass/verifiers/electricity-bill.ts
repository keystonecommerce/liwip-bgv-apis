import type { Verifier } from "../verifier";
import { ELECTRICITY_BILL as BILL_CHECK } from "../checks/electricity-bill";
import { nameStatus } from "../verdicts";

/** Same request as the ELECTRICITY_BILL supplementary check, judged against the worker's names. */
export const ELECTRICITY_BILL: Verifier = {
  type: "ELECTRICITY_BILL",
  label: "Electricity Bill",
  call: (transport, payload) => transport.request(BILL_CHECK.build({ consumerNumber: String(payload.consumerNumber), operatorCode: String(payload.operatorCode) }, {})),
  // The bill is often in a parent's or landlord's name, so a different name goes to review.
  verdict: (payload) => nameStatus(payload, ["full_name"], { strict: true })
};
