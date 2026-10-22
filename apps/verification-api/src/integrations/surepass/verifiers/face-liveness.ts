import type { Verifier } from "../verifier";
import { verifyFaceLiveness } from "../apis/verify-face-liveness";

export const FACE_LIVENESS: Verifier = {
  type: "FACE_LIVENESS",
  label: "Face Liveness",
  call: (transport, payload) => verifyFaceLiveness(transport, payload as unknown as Parameters<typeof verifyFaceLiveness>[1]),
  verdict: () => (data) => data.live === true ? "verified" : "failed"
};
