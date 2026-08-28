export const DOCUMENT_TYPES = [
  "AADHAAR",
  "PAN",
  "VOTER_ID",
  "DRIVING_LICENSE",
  "PASSPORT",
  "SELFIE",
  "ID_CARD",
  "ADDRESS_PROOF",
  "EDUCATION_CERTIFICATE",
  "SKILL_CERTIFICATE",
  "VEHICLE_RC",
  "VEHICLE_INSURANCE",
  "PUC_CERTIFICATE",
  "VEHICLE_PERMIT",
  "GST_CERTIFICATE",
  "OTHER"
] as const;

export type DocumentType = typeof DOCUMENT_TYPES[number];

export const ALLOWED_DOCUMENT_CONTENT_TYPES = new Set([
  "application/pdf",
  "application/zip",
  "application/x-zip-compressed",
  "application/xml",
  "text/xml",
  "image/jpeg",
  "image/png",
  "image/webp"
]);

export interface CreateDocumentUploadRequest {
  document_type?: string;
  file_name?: string;
  content_type?: string;
  size_bytes?: number;
  checksum_sha256?: string;
}
