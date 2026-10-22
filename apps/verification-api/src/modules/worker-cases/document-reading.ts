import { isoDate } from "../../domain/dates";
import type { SupplementaryCheckType } from "../../domain/supplementary-checks";
import { enabledProducts } from "../../integrations/surepass/products";
import type { WorkerCheckKind } from "./worker-case.inputs";

/**
 * Checks whose document can be photographed and read (Surepass OCR) to pre-fill what the worker
 * would type. `front` is always needed; the licence also needs its `back`.
 */
export const READABLE_DOCUMENTS = {
  PAN: { ocr: "PAN_OCR", product: "ocr-pan", files: ["front"] },
  DRIVING_LICENSE: { ocr: "LICENSE_OCR", product: "ocr-license", files: ["front", "back"] },
  PASSPORT: { ocr: "PASSPORT_OCR", product: "ocr-passport", files: ["front"] }
} as const satisfies Partial<Record<WorkerCheckKind, { ocr: SupplementaryCheckType; product: string; files: readonly ("front" | "back")[] }>>;

export type ReadableKind = keyof typeof READABLE_DOCUMENTS;

export const isReadableKind = (kind: string): kind is ReadableKind => Object.prototype.hasOwnProperty.call(READABLE_DOCUMENTS, kind);

/** Whether the worker app may offer the camera for this check now. */
export const canReadDocument = (kind: string) => isReadableKind(kind) && enabledProducts().has(READABLE_DOCUMENTS[kind].product);

/** Below this confidence (0 to 100) the app asks the worker to look at the field twice. */
export const LOW_CONFIDENCE = 80;

interface OcrValue { value?: unknown; confidence?: unknown }

/**
 * What a photo gave us: `fields` are exactly what POST checks/:kind takes, for the worker to
 * confirm; `details` are shown alongside (name, date of birth); `lowConfidence` lists the fields
 * to look at again. Nothing here is stored.
 */
export interface DocumentReading {
  kind: ReadableKind;
  fields: Record<string, string>;
  details: Record<string, string>;
  lowConfidence: string[];
}

const text = (field: OcrValue | undefined) => String(field?.value ?? "").trim().replace(/\s+/g, " ");
const compact = (field: OcrValue | undefined) => text(field).toUpperCase().replace(/[\s-]/g, "");
const confidence = (field: OcrValue | undefined) => (typeof field?.confidence === "number" ? field.confidence : 0);

/** Surepass OCR data → the check's fields. Empty when nothing usable was read. */
export function readingFrom(kind: ReadableKind, data: Record<string, unknown> | null | undefined): DocumentReading {
  const reading: DocumentReading = { kind, fields: {}, details: {}, lowConfidence: [] };
  const put = (target: "fields" | "details", name: string, value: string, field: OcrValue | undefined) => {
    if (!value) return;
    reading[target][name] = value;
    if (target === "fields" && confidence(field) < LOW_CONFIDENCE) reading.lowConfidence.push(name);
  };
  const first = (Array.isArray(data?.ocr_fields) ? data.ocr_fields[0] : undefined) as Record<string, OcrValue> | undefined;
  if (kind === "PAN") {
    put("fields", "panNumber", compact(first?.pan_number), first?.pan_number);
    put("details", "name", text(first?.full_name), first?.full_name);
    put("details", "fatherName", text(first?.father_name), first?.father_name);
    put("details", "dateOfBirth", isoDate(text(first?.dob)) ?? "", first?.dob);
  } else if (kind === "DRIVING_LICENSE") {
    const licence = data as Record<string, OcrValue> | undefined;
    put("fields", "licenceNumber", compact(licence?.license_number), licence?.license_number);
    put("fields", "dateOfBirth", isoDate(text(licence?.dob)) ?? "", licence?.dob);
  } else {
    put("fields", "fileNumber", compact(first?.file_num), first?.file_num);
    put("details", "fatherName", text(first?.father), first?.father);
    put("details", "address", [text(first?.address), text(first?.pin)].filter(Boolean).join(" "), first?.address);
  }
  return reading;
}
