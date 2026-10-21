import { BadRequestException } from "@nestjs/common";

export const supplementaryChecks = {
  NAME_MATCH: { fields: ["name1", "name2"], consent: "identity" },
  MOBILE_NAME: { fields: ["mobileNumber"], consent: "identity" },
  EMAIL_CHECK: { fields: ["email"], consent: "identity" },
  IFSC: { fields: ["ifsc"], consent: "identity" },
  UPI: { fields: ["upiId"], consent: "identity" },
  BANK_ACCOUNT: { fields: ["accountNumber", "ifsc"], consent: "identity" },
  BANK_REPORT: { fields: ["accountNumber", "ifsc"], consent: "identity" },
  DIGIPIN: { fields: ["latitude", "longitude"], consent: "address" },
  ELECTRICITY_BILL: { fields: ["consumerNumber", "operatorCode"], consent: "address" },
  VEHICLE_CHALLAN: { fields: ["registrationNumber"], consent: "identity" },
  PREFILL_BY_MOBILE: { fields: ["mobile"], consent: "identity" },
  AADHAAR_OCR: { fields: [], files: ["file"], consent: "identity" },
  AADHAAR_OCR_FULL: { fields: [], files: ["front", "back"], consent: "identity" },
  PAN_OCR: { fields: [], files: ["file"], consent: "identity" },
  VOTER_OCR: { fields: [], files: ["file"], consent: "identity" },
  PASSPORT_OCR: { fields: [], files: ["file"], consent: "identity" },
  LICENSE_OCR: { fields: [], files: ["front", "back"], consent: "identity" },
  AADHAAR_MASK: { fields: [], files: ["file"], consent: "identity" },
  AML: { fields: ["name", "dob", "nationality", "address"], consent: "identity" },
  PEP: { fields: ["name", "dob", "nationality", "address"], consent: "identity" },
  DOCTOR_REGISTRATION: { fields: ["registrationNumber", "registrationYear"], consent: "identity" },
  ICSI: { fields: ["membershipNumber"], consent: "identity" },
  EXPERIAN_REPORT: { fields: ["name", "mobile", "pan"], consent: "credit" },
  CRIF_REPORT: { fields: ["firstName", "lastName", "mobile", "pan"], consent: "credit" }
} as const;

export type SupplementaryCheckType = keyof typeof supplementaryChecks;
export interface CheckFile { buffer: Buffer; originalname: string; mimetype: string; }
export type CheckFiles = Partial<Record<"file" | "front" | "back", CheckFile>>;

export function isSupplementaryCheck(type: string): type is SupplementaryCheckType {
  return Object.prototype.hasOwnProperty.call(supplementaryChecks, type);
}

/** Validate our contract before sending a billable request. No provider fields leak into it. */
export function validateCheck(type: SupplementaryCheckType, input: Record<string, unknown>, files: CheckFiles = {}): void {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new BadRequestException("Check input must be an object");
  const spec = supplementaryChecks[type];
  const allowed = new Set<string>([...spec.fields, "usePdf"]);
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw new BadRequestException(`Unexpected check field: ${key}`);
  for (const key of spec.fields) {
    const value = input[key];
    if (typeof value !== "string" || !value.trim() || value.length > 2000 || value === "undefined" || value === "null") {
      throw new BadRequestException(`${key} must be a non-empty string (maximum 2000 characters)`);
    }
  }
  if (input.usePdf !== undefined && ![true, false, "true", "false"].includes(input.usePdf as any)) throw new BadRequestException("usePdf must be true or false");
  const requiredFiles: readonly string[] = "files" in spec ? spec.files : [];
  for (const key of requiredFiles) if (!files[key as keyof CheckFiles]?.buffer?.length) throw new BadRequestException(`${key} upload is required`);
  for (const [key, file] of Object.entries(files)) {
    if (!requiredFiles.includes(key)) throw new BadRequestException(`Unexpected file field: ${key}`);
    if (!file || file.buffer.length > 5 * 1024 * 1024 || !["image/jpeg", "image/png", "application/pdf"].includes(file.mimetype)) {
      throw new BadRequestException("Upload JPEG, PNG or PDF files up to 5 MiB");
    }
  }
  for (const key of ["mobileNumber", "mobile"]) if (input[key] !== undefined && !/^[6-9]\d{9}$/.test(String(input[key]))) throw new BadRequestException(`${key} must be a 10-digit Indian mobile number`);
  if (input.pan !== undefined && !/^[A-Z]{5}\d{4}[A-Z]$/.test(String(input.pan))) throw new BadRequestException("Invalid PAN format");
  if (input.ifsc !== undefined && !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(String(input.ifsc))) throw new BadRequestException("Invalid IFSC format");
  if ((type === "BANK_REPORT" || type === "BANK_ACCOUNT") && !/^\d{6,20}$/.test(String(input.accountNumber))) throw new BadRequestException("Invalid bank account number");
  if (type === "VEHICLE_CHALLAN" && !/^[A-Z0-9]{6,12}$/.test(String(input.registrationNumber))) throw new BadRequestException("Invalid vehicle registration number");
  if (type === "ELECTRICITY_BILL") {
    if (!/^[A-Za-z0-9-]{4,30}$/.test(String(input.consumerNumber))) throw new BadRequestException("Invalid electricity consumer number");
    if (!/^[A-Z]{2,5}$/.test(String(input.operatorCode))) throw new BadRequestException("Invalid electricity operator code");
  }
  if (type === "UPI" && !/^[\w.\-]+@[\w.\-]+$/.test(String(input.upiId))) throw new BadRequestException("Invalid UPI ID");
  if (type === "EMAIL_CHECK" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(input.email))) throw new BadRequestException("Invalid email address");
  if (type === "DIGIPIN") {
    for (const [key, limit] of [["latitude", 90], ["longitude", 180]] as const) {
      if (!/^-?\d+(\.\d+)?$/.test(String(input[key])) || Math.abs(Number(input[key])) > limit) throw new BadRequestException(`Invalid ${key}`);
    }
  }
}
