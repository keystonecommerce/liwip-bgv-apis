import { BadRequestException } from "@nestjs/common";
import type { ApplicationSchema, VerificationType } from "../../domain/verification.types";

/** Checks a worker submits input for. FACE runs liveness and face match together. */
export type WorkerCheckKind = "PAN" | "DRIVING_LICENSE" | "RC_V2" | "VOTER_ID" | "PASSPORT" | "EMPLOYMENT_HISTORY" | "ECOURTS_SEARCH" | "FACE";

/**
 * What a worker can choose to verify. Each choice needs one consent item and,
 * for FACE, a verified Aadhaar (the photo face match compares against).
 */
export type SelectableCheck = "AADHAAR" | WorkerCheckKind;
export const SELECTABLE_CHECKS: Record<SelectableCheck, { types: VerificationType[]; consent: string; requires?: SelectableCheck }> = {
  // Ordered by importance: what every worker has first, the rarer documents last.
  AADHAAR: { types: ["AADHAAR"], consent: "identity" },
  PAN: { types: ["PAN"], consent: "identity" },
  FACE: { types: ["FACE_LIVENESS", "FACE_MATCH"], consent: "face", requires: "AADHAAR" },
  DRIVING_LICENSE: { types: ["DRIVING_LICENSE"], consent: "identity" },
  VOTER_ID: { types: ["VOTER_ID"], consent: "identity" },
  RC_V2: { types: ["RC_V2"], consent: "vehicle" },
  ECOURTS_SEARCH: { types: ["ECOURTS_SEARCH"], consent: "court" },
  EMPLOYMENT_HISTORY: { types: ["EMPLOYMENT_HISTORY"], consent: "employment" },
  PASSPORT: { types: ["PASSPORT"], consent: "identity" }
};

export function isSelectableCheck(value: string): value is SelectableCheck {
  return Object.prototype.hasOwnProperty.call(SELECTABLE_CHECKS, value);
}

export const CHECK_TYPES_FOR: Record<WorkerCheckKind, VerificationType[]> = {
  PAN: ["PAN"],
  DRIVING_LICENSE: ["DRIVING_LICENSE"],
  RC_V2: ["RC_V2"],
  VOTER_ID: ["VOTER_ID"],
  PASSPORT: ["PASSPORT"],
  EMPLOYMENT_HISTORY: ["EMPLOYMENT_HISTORY"],
  ECOURTS_SEARCH: ["ECOURTS_SEARCH"],
  FACE: ["FACE_LIVENESS", "FACE_MATCH"]
};

export function isWorkerCheckKind(value: string): value is WorkerCheckKind {
  return Object.prototype.hasOwnProperty.call(CHECK_TYPES_FOR, value);
}

const compact = (value: unknown) => String(value ?? "").toUpperCase().replace(/[\s-]/g, "");

function field(input: Record<string, unknown>, name: string, pattern: RegExp, message: string, normalise = compact): string {
  const value = normalise(input[name]);
  if (!pattern.test(value)) throw new BadRequestException(message);
  return value;
}

/** Accepts YYYY-MM-DD, DD-MM-YYYY or DD/MM/YYYY and returns YYYY-MM-DD. */
export function isoDate(value: unknown): string | undefined {
  const text = String(value ?? "").trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  const indian = /^(\d{2})[-/](\d{2})[-/](\d{4})$/.exec(text);
  const [year, month, day] = iso ? [iso[1], iso[2], iso[3]] : indian ? [indian[3], indian[2], indian[1]] : [];
  if (!year) return undefined;
  const date = new Date(`${year}-${month}-${day}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.getUTCDate() !== Number(day) ? undefined : `${year}-${month}-${day}`;
}

/** Validates what the worker typed and returns the change to case data. */
export function applyCheckInput(kind: Exclude<WorkerCheckKind, "FACE">, input: Record<string, unknown>, data: ApplicationSchema): ApplicationSchema {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new BadRequestException("Send the check details as an object");
  const personal = { ...data.personal };
  if (kind === "PAN") {
    personal.panNumber = field(input, "panNumber", /^[A-Z]{5}\d{4}[A-Z]$/, "Enter a valid 10-character PAN");
    return { ...data, personal };
  }
  if (kind === "DRIVING_LICENSE") {
    personal.drivingLicenceNumber = field(input, "licenceNumber", /^[A-Z]{2}[0-9A-Z]{8,16}$/, "Enter the driving licence number as printed");
    const dob = input.dateOfBirth === undefined ? personal.dateOfBirth : isoDate(input.dateOfBirth);
    if (!dob) throw new BadRequestException("Enter the date of birth on the licence");
    personal.drivingLicenceDob = dob;
    return { ...data, personal };
  }
  if (kind === "RC_V2") {
    const registrationNumber = field(input, "registrationNumber", /^[A-Z0-9]{6,12}$/, "Enter the vehicle number as on the RC");
    return { ...data, vehicle: { ...data.vehicle, registrationNumber } };
  }
  if (kind === "VOTER_ID") {
    personal.voterId = field(input, "voterId", /^[A-Z]{3}\d{7}$/, "Enter the 10-character voter ID (EPIC) number");
    return { ...data, personal };
  }
  if (kind === "PASSPORT") {
    personal.passportFileNumber = field(input, "fileNumber", /^[A-Z0-9]{10,15}$/, "Enter the passport file number");
    return { ...data, personal };
  }
  if (kind === "EMPLOYMENT_HISTORY") {
    const uan = field(input, "uan", /^\d{12}$/, "Enter your 12-digit UAN");
    return { ...data, employment: { ...data.employment, uan } };
  }
  // ECOURTS_SEARCH: the court search needs a father's name and an address.
  const fatherName = data.criminal?.fatherName || personName(input.fatherName, "Enter your father's name");
  const submittedAddress = data.personal.submittedAddress || address(input.address);
  return { ...data, personal: { ...personal, submittedAddress }, criminal: { ...data.criminal, fatherName } };
}

export function personName(value: unknown, message: string): string {
  const name = String(value ?? "").trim().replace(/\s+/g, " ");
  if (!/^[\p{L} .'-]{2,80}$/u.test(name)) throw new BadRequestException(message);
  return name;
}

export function address(value: unknown): string {
  const text = String(value ?? "").trim().replace(/\s+/g, " ");
  if (text.length < 10 || text.length > 300) throw new BadRequestException("Enter your full address with PIN code");
  return text;
}

/** "S/O: Ramesh Kumar" → "Ramesh Kumar". Only son/daughter-of gives a father's name. */
export function fatherFromCareOf(careOf: string | undefined): string | undefined {
  const match = /^\s*[SD]\s*\/\s*O\s*[:.\s]\s*(.+)$/i.exec(careOf || "");
  return match?.[1]?.trim() || undefined;
}
