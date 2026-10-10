import { requireUpload } from "../input-validation";
import { SurepassTransport } from "../surepass.transport";
import type { RawProviderResponse } from "../../verification-provider";

export async function verifyFaceLiveness(transport: SurepassTransport, payload: { buffer: Buffer; originalname: string; mimetype: string }): Promise<RawProviderResponse> {
  requireUpload(payload);
  const form = new FormData();
  const bytes = new Uint8Array(payload.buffer.length);
  bytes.set(payload.buffer);
  form.append("file", new Blob([bytes], { type: payload.mimetype || "image/jpeg" }), payload.originalname || "selfie.jpg");
  return transport.send(`/api/v1/face/face-liveness`, {
    method: "POST",
    body: form
  });
}
