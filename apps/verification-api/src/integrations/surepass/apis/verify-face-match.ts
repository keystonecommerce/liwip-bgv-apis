import { requireUpload } from "../input-validation";
import { SurepassTransport } from "../surepass.transport";
import type { RawProviderResponse } from "../../verification-provider";

export async function verifyFaceMatch(transport: SurepassTransport, payload: {
  selfie: { buffer: Buffer; originalname: string; mimetype: string };
  idCard: { buffer: Buffer; originalname: string; mimetype: string };
  selfie2?: { buffer: Buffer; originalname: string; mimetype: string };
  }): Promise<RawProviderResponse> {
  requireUpload(payload?.selfie);
  requireUpload(payload?.idCard);
  if (payload.selfie2) requireUpload(payload.selfie2);
  const form = new FormData();
  const appendFile = (name: string, file: { buffer: Buffer; originalname: string; mimetype: string }) => {
    const bytes = new Uint8Array(file.buffer.length);
    bytes.set(file.buffer);
    form.append(name, new Blob([bytes], { type: file.mimetype || "image/jpeg" }), file.originalname || `${name}.jpg`);
  };
  appendFile("selfie", payload.selfie);
  appendFile("id_card", payload.idCard);
  if (payload.selfie2) appendFile("selfie_2", payload.selfie2);
  return transport.send(`/api/v1/face/face-match`, {
    method: "POST",
    body: form
  });
}
