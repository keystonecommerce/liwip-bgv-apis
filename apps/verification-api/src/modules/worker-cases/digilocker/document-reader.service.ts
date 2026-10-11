import { Inject, Injectable } from "@nestjs/common";
import { DocumentExtractor } from "../../../integrations/bedrock/document-extractor";
import { SurepassTransport } from "../../../integrations/surepass/surepass.transport";
import { isDigiLockerDocType, sharedDocuments, type SharedDocument } from "./documents";
import { isTrustedDigiLockerSigner, signerName, verifyPdfSignature } from "./pdf-signature";
import { pdfText, trimForExtraction } from "./pdf-text";

const MAX_PDF_BYTES = 10 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 15_000;

/** A document number read from DigiLocker, and who signed the document it came from. */
export interface DocumentNumber {
  number: string;
  signedBy?: string;
  signedAt?: string;
}

/**
 * Reads the documents a worker shared on DigiLocker's consent screen. DigiLocker access lasts
 * minutes, so callers read everything straight after the worker returns. Every method returns
 * null on any doubt; the worker then types the number instead.
 */
@Injectable()
export class DigiLockerDocumentReader {
  constructor(
    @Inject(SurepassTransport) private readonly surepass: SurepassTransport,
    @Inject(DocumentExtractor) private readonly extractor: DocumentExtractor
  ) {}

  /** Documents the worker ticked, or null when the list cannot be read. */
  async list(sessionId: string): Promise<SharedDocument[] | null> {
    try {
      return sharedDocuments((await this.surepass.request({ path: `/api/v1/digilocker/list-documents/${encodeURIComponent(sessionId)}`, method: "GET" })).body);
    } catch {
      return null;
    }
  }

  /**
   * The number on a shared document: from its URI when it carries one, otherwise from the
   * signed PDF (signature checked, text read, unneeded lines dropped, fields picked out by
   * the model). The number must appear in the PDF text itself.
   */
  async number(sessionId: string, doc: SharedDocument): Promise<DocumentNumber | null> {
    if (doc.number) return { number: doc.number };
    if (!doc.fileId || !isDigiLockerDocType(doc.doctype)) return null;
    try {
      const pdf = await this.download(sessionId, doc.fileId);
      if (!pdf) return null;
      const signature = await verifyPdfSignature(pdf);
      if (!isTrustedDigiLockerSigner(signature)) return null;
      const text = await pdfText(pdf);
      const number = (await this.extractor.extract(doc.doctype, trimForExtraction(text)))?.number;
      if (!number || !compact(text).includes(number)) return null;
      return { number, signedBy: signerName(signature.signer?.organisation), signedAt: signature.signedAt };
    } catch {
      return null;
    }
  }

  private async download(sessionId: string, fileId: string): Promise<Buffer | null> {
    const link = (await this.surepass.request({
      path: `/api/v1/digilocker/download-document/${encodeURIComponent(sessionId)}/${encodeURIComponent(fileId)}`,
      method: "GET"
    })).body as { data?: { download_url?: string; mime_type?: string } } | null;
    const url = httpsUrl(link?.data?.download_url);
    if (!url || !/pdf/i.test(link?.data?.mime_type ?? "pdf")) return null;
    const response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!response.ok || !httpsUrl(response.url || url.href) || Number(response.headers.get("content-length") ?? 0) > MAX_PDF_BYTES) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    return readCapped(response, MAX_PDF_BYTES);
  }
}

/** The provider's download link, only when it is a well-formed https URL. */
function httpsUrl(value: unknown): URL | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/** Reads the body, giving up once it passes `limit` bytes (Content-Length can be absent or wrong). */
async function readCapped(response: Response, limit: number): Promise<Buffer | null> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

const compact = (text: string) => text.toUpperCase().replace(/[^A-Z0-9]/g, "");
