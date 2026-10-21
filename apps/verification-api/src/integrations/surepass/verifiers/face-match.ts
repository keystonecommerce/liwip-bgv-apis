import type { Verifier } from "../verifier";
import { verifyFaceMatch } from "../apis/verify-face-match";

export const FACE_MATCH: Verifier = {
  type: "FACE_MATCH",
  label: "Face Match",
  call: (transport, payload) => verifyFaceMatch(transport, payload as unknown as Parameters<typeof verifyFaceMatch>[1]),
  verdict: () => (data) => data.match_status === true ? "verified" : "failed"
};
