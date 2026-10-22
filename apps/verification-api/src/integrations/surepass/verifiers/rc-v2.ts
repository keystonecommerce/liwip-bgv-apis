import type { Verifier } from "../verifier";
import { verifyRcFull } from "../apis/verify-rc-full";
import { verifyRcV2 } from "../apis/verify-rc-v2";
import { enabledProducts } from "../products";
import { nameStatus } from "../verdicts";

/** The vehicle check. */
export const RC_V2: Verifier = {
  type: "RC_V2",
  label: "RC",
  call: (transport, payload) => {
    // RC V2 when the account has it, else RC Text (RC Full): both return owner, insurance, PUC, fitness and permit.
    const idNumber = String(payload.idNumber);
    return enabledProducts().has("rc-v2") ? verifyRcV2(transport, { idNumber, enrich: false }) : verifyRcFull(transport, { idNumber });
  },
  // The owner is often a fleet or family member, so a different name goes to review, not failed.
  verdict: (payload) => nameStatus(payload, ["owner_name"], { strict: true })
};
