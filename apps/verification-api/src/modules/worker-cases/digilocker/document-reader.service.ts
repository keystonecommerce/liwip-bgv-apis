import { Inject, Injectable } from "@nestjs/common";
import { DocumentExtractor } from "../../../integrations/bedrock/document-extractor";
import { SurepassTransport } from "../../../integrations/surepass/surepass.transport";
import { isExtractable, sharedDocuments, signerName, type SharedDocument } from "./documents";
import { isTrustedDigiLockerSigner, verifyPdfSignature } from "./pdf-signature";
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
    if (!doc.fileId || !isExtractable(doc.doctype)) return null;
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
    const url = link?.data?.download_url;
    if (!url || !/pdf/i.test(link?.data?.mime_type ?? "pdf")) return null;
    const response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!response.ok || Number(response.headers.get("content-length") ?? 0) > MAX_PDF_BYTES) return null;
    const pdf = Buffer.from(await response.arrayBuffer());
    return pdf.length > MAX_PDF_BYTES ? null : pdf;
  }
}

const compact = (text: string) => text.toUpperCase().replace(/[^A-Z0-9]/g, "");
