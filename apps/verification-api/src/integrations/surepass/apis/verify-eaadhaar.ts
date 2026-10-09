import { requireFields, requireUpload } from "../input-validation";
import { SurepassTransport } from "../surepass.transport";
import type { RawProviderResponse } from "../../verification-provider";

export async function verifyEaadhaar(transport: SurepassTransport, payload: {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
  fullName: string;
  yearOfBirth: string;
  }): Promise<RawProviderResponse> {
  requireFields(payload, ["fullName", "yearOfBirth"]);
  requireUpload(payload);
  const form = new FormData();
  const bytes = new Uint8Array(payload.buffer.length);
  bytes.set(payload.buffer);
  const blob = new Blob([bytes], { type: payload.mimetype || "application/pdf" });
  const fileField = process.env.SUREPASS_EAADHAAR_FILE_FIELD || "file";
  form.append(fileField, blob, payload.originalname || "eaadhaar.pdf");
  form.append("base64", payload.buffer.toString("base64"));
  form.append("yob", payload.yearOfBirth);
  form.append("full_name", payload.fullName);
  return transport.send(`/api/v1/aadhaar/upload/eaadhaar`, {
    method: "POST",
    body: form
  });
}
