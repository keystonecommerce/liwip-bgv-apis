/** The file types we accept from people's cameras and uploads, told apart by their first bytes. */
export type SniffedType = "image/jpeg" | "image/png" | "image/webp" | "application/pdf";

export function sniffFileType(bytes: Buffer): SniffedType | null {
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  if (bytes.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  return null;
}

/** The declared type, when the bytes agree with it and it is one of `allowed`. */
export function checkedFileType(bytes: Buffer, declared: string, allowed: readonly SniffedType[]): SniffedType | null {
  const sniffed = sniffFileType(bytes);
  return sniffed && sniffed === String(declared || "").split(";", 1)[0].trim().toLowerCase() && allowed.includes(sniffed) ? sniffed : null;
}
