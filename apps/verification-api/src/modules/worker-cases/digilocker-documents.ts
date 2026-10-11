import type { WorkerCheckKind } from "./worker-case.inputs";

/**
 * Documents a worker can share from DigiLocker alongside Aadhaar, and the check each one
 * starts. DigiLocker names an issued document by a URI that ends in its type and number,
 * e.g. `in.gov.pan-PANCR-ABCDE1234F`, so the number is read from there and the usual
 * registry check runs on it, matched to Aadhaar like any other.
 */
export const DIGILOCKER_DOCUMENTS = {
  PANCR: { check: "PAN", input: "panNumber" },
  DRVLC: { check: "DRIVING_LICENSE", input: "licenceNumber" },
  RVCER: { check: "RC_V2", input: "registrationNumber" }
} as const satisfies Record<string, { check: Exclude<WorkerCheckKind, "FACE">; input: string }>;

export type DigiLockerDocType = keyof typeof DIGILOCKER_DOCUMENTS;

export interface SharedDocument {
  doctype: string;
  /** Present for the document types above when the URI carries it. */
  number?: string;
  issuer?: string;
  name?: string;
}

const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);

/** The list of documents, wherever the provider puts it in the response. */
function items(body: unknown): Record<string, unknown>[] {
  const data = (body as { data?: unknown } | null)?.data ?? body;
  const list = Array.isArray(data)
    ? data
    : ["documents", "items", "issued", "files"].map((key) => (data as Record<string, unknown> | null)?.[key]).find(Array.isArray) ?? [];
  return (list as unknown[]).filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object");
}

/** Documents the worker ticked on DigiLocker's consent screen. Unknown shapes give an empty list. */
export function sharedDocuments(body: unknown): SharedDocument[] {
  return items(body).map((item) => {
    const uri = text(item.uri) ?? text(item.doc_uri) ?? text(item.file_id) ?? text(item.id) ?? "";
    const fromUri = /-([A-Z]{5})-([A-Z0-9-]+)$/i.exec(uri);
    const doctype = (text(item.doctype) ?? text(item.doc_type) ?? fromUri?.[1] ?? "").toUpperCase();
    const number = fromUri && fromUri[1].toUpperCase() === doctype ? fromUri[2].toUpperCase().replace(/[^A-Z0-9]/g, "") : undefined;
    return { doctype, number, issuer: text(item.issuer), name: text(item.name) ?? text(item.description) };
  }).filter((doc) => doc.doctype);
}
