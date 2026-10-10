import type { CheckFiles, SupplementaryCheckType } from "../../domain/supplementary-checks";
import type { ProviderResponse } from "../verification-provider";
import type { SurepassRequest } from "./surepass.transport";

export interface CheckContract {
  type: SupplementaryCheckType;
  source: string;
  build(input: Record<string, unknown>, files: CheckFiles): SurepassRequest;
  /** Fetch/extraction success alone is not a background-verification pass. */
  status?(data: Record<string, unknown>): NonNullable<ProviderResponse["status"]>;
}

export function jsonRequest(path: string, input: Record<string, unknown>, mapping: Record<string, string>, extra = {}): SurepassRequest {
  return { path: `/api/v1/${path}`, body: { ...Object.fromEntries(Object.entries(mapping).map(([local, remote]) => [remote, input[local]])), ...extra } };
}

export function fileRequest(path: string, input: Record<string, unknown>, files: CheckFiles): SurepassRequest {
  const form = new FormData();
  for (const [field, file] of Object.entries(files)) {
    if (file) form.append(field, new Blob([new Uint8Array(file.buffer)], { type: file.mimetype }), file.originalname);
  }
  if (input.usePdf !== undefined) form.append("use_pdf", String(input.usePdf));
  else if (Object.values(files).some(file => file?.mimetype === "application/pdf")) form.append("use_pdf", "true");
  return { path: `/api/v1/${path}`, body: form };
}
