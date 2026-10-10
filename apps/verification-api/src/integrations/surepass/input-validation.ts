import { UnrecoverableError } from "bullmq";

export function requireFields(payload: Record<string, unknown>, fields: string[]): void {
  for (const field of fields) {
    const value = payload?.[field];
    if (typeof value !== "string" || !value.trim() || value === "undefined" || value === "null") {
      throw Object.assign(new UnrecoverableError(`Missing provider input: ${field}`), { code: "MISSING_VERIFICATION_INPUT" });
    }
  }
}

export function requireUpload(file: { buffer: Buffer; mimetype: string } | undefined): void {
  if (!file || !Buffer.isBuffer(file.buffer) || !file.buffer.length || file.buffer.length > 10 * 1024 * 1024) {
    throw Object.assign(new UnrecoverableError("Verification requires an uploaded file up to 10 MiB"), { code: "MISSING_VERIFICATION_INPUT" });
  }
}
