import type { Verifier } from "../verifier";
import { verifyCibilScore } from "../apis/verify-cibil-score";

/** A credit score is never a pass by itself. */
export const CIBIL_SCORE: Verifier = {
  type: "CIBIL_SCORE",
  label: "CIBIL Score",
  call: (transport, payload) => verifyCibilScore(transport, {
    pan: String(payload.pan),
    mobile: String(payload.mobile),
    name: String(payload.name),
    gender: String(payload.gender) as "male" | "female"
  }),
  verdict: () => () => "manual_review"
};
