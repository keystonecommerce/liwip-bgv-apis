import { requireUpload } from "../input-validation";
import { SurepassTransport } from "../surepass.transport";
import type { RawProviderResponse } from "../../verification-provider";

export async function verifyGst(transport: SurepassTransport, file: { buffer: Buffer; originalname: string; mimetype: string }): Promise<RawProviderResponse> {
  requireUpload(file);
  const form = new FormData();
  const bytes = new Uint8Array(file.buffer.length);
  bytes.set(file.buffer);
  const blob = new Blob([bytes], { type: file.mimetype || "application/octet-stream" });
  form.append("file", blob, file.originalname || "gst-certificate");
  return transport.send(`/api/v1/ocr/gst`, {
    method: "POST",
    body: form
  });
}
