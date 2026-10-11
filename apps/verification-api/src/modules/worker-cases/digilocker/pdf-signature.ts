import { execFile } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

const OPENSSL_TIMEOUT_MS = 5_000;

export type PdfSignature = {
  valid: boolean;
  coversWholeFile: boolean;
  signer: { organisation?: string; commonName?: string } | null;
  issuer?: string;
  /** ISO 8601. */
  signedAt?: string;
  /** Why the signature is not valid. */
  reason?: string;
};

/**
 * Organisations whose signature we accept on DigiLocker-issued PDFs (keys compared
 * case-insensitively), with the name we show for each.
 */
const TRUSTED_DIGILOCKER_SIGNERS: Record<string, string> = {
  "NATIONAL E-GOVERNANCE DIVISION": "National e-Governance Division (NeGD)",
  "MINISTRY OF ROAD TRANSPORT AND HIGHWAYS": "Ministry of Road Transport and Highways (MoRTH)",
  "MINISTRY OF ROAD TRANSPORT & HIGHWAYS": "Ministry of Road Transport and Highways (MoRTH)"
};

type SignatureField = { byteRange: [number, number, number, number]; der: Buffer; dictWindow: string };

/**
 * Verifies the PDF's (last) detached PKCS#7/CMS signature with the `openssl` binary.
 *
 * Only integrity is checked (`-noverify`): the signed bytes match the signature made by the
 * embedded signer certificate. Validating that certificate's chain up to the CCA India root is
 * a later step. Never throws.
 */
export async function verifyPdfSignature(pdf: Buffer): Promise<PdfSignature> {
  try {
    if (!Buffer.isBuffer(pdf) || pdf.length === 0) return invalid("No signature");
    const field = findSignatureField(pdf);
    if (typeof field === "string") return invalid(field);

    const [a, b, c, d] = field.byteRange;
    const coversWholeFile = a === 0 && c + d === pdf.length;
    const signedBytes = Buffer.concat([pdf.subarray(a, a + b), pdf.subarray(c, c + d)]);

    const cms = await opensslVerify(field.der, signedBytes);
    const signedAt = cms.signingTime ?? pdfSigningTime(field.dictWindow);
    const reason = !cms.ok ? cms.reason : !coversWholeFile ? "Signature does not cover the whole file" : undefined;
    return {
      valid: cms.ok && coversWholeFile,
      coversWholeFile,
      signer: cms.signer,
      ...(cms.issuer ? { issuer: cms.issuer } : {}),
      ...(signedAt ? { signedAt } : {}),
      ...(reason ? { reason } : {})
    };
  } catch (error) {
    return invalid(`Could not verify signature: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function isTrustedDigiLockerSigner(sig: PdfSignature): boolean {
  const org = sig.signer?.organisation?.trim().toUpperCase();
  return sig.valid && !!org && Object.prototype.hasOwnProperty.call(TRUSTED_DIGILOCKER_SIGNERS, org);
}

/** The signer's name as we show it ("Signed by National e-Governance Division (NeGD)"). */
export function signerName(organisation: string | undefined): string | undefined {
  return organisation ? TRUSTED_DIGILOCKER_SIGNERS[organisation.trim().toUpperCase()] ?? organisation : undefined;
}

function invalid(reason: string): PdfSignature {
  return { valid: false, coversWholeFile: false, signer: null, reason };
}

/**
 * Takes the last `/ByteRange [a b c d]` in the file (the newest signature when there are
 * incremental updates). By the PDF spec the gap between the two ranges is exactly the
 * `/Contents <hex>` string, so we read the hex from there rather than matching it separately.
 */
function findSignatureField(pdf: Buffer): SignatureField | string {
  const text = pdf.toString("latin1");
  const re = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g;
  let match: RegExpExecArray | null;
  let last: RegExpExecArray | null = null;
  while ((match = re.exec(text))) last = match;
  if (!last) return "No signature";

  const [a, b, c, d] = last.slice(1, 5).map(Number) as [number, number, number, number];
  if (![a, b, c, d].every(Number.isSafeInteger) || a + b > c || c + d > pdf.length || b === 0) {
    return "Malformed ByteRange";
  }
  if (text[a + b] !== "<" || text[c - 1] !== ">") return "Signature contents not found at ByteRange gap";
  const hex = text.slice(a + b + 1, c - 1).replace(/\s+/g, "");
  if (!hex || !/^[0-9A-Fa-f]+$/.test(hex) || hex.length % 2 !== 0) return "Malformed signature contents";

  const der = derPrefix(Buffer.from(hex, "hex"));
  if (!der) return "Malformed signature contents";

  // Text around the signature dictionary (excluding the big hex blob) for `/M (D:...)`.
  const dictWindow = text.slice(Math.max(0, last.index - 4096), a + b) + text.slice(c, Math.min(text.length, c + 4096));
  return { byteRange: [a, b, c, d], der, dictWindow };
}

/**
 * `/Contents` is zero-padded to a fixed size and the DER itself may end in zero bytes, so the
 * real length comes from the outer ASN.1 SEQUENCE header, not from stripping trailing zeros.
 */
function derPrefix(buf: Buffer): Buffer | null {
  if (buf.length < 2 || buf[0] !== 0x30) return null;
  const first = buf[1];
  if (first === 0x80) return buf; // BER indefinite length: hand openssl everything
  let length = first;
  let header = 2;
  if (first & 0x80) {
    const n = first & 0x7f;
    if (n < 1 || n > 4 || buf.length < 2 + n) return null;
    length = 0;
    for (let i = 0; i < n; i += 1) length = length * 256 + buf[2 + i];
    header = 2 + n;
  }
  const total = header + length;
  return total <= buf.length ? buf.subarray(0, total) : null;
}

type CmsResult = {
  ok: boolean;
  reason?: string;
  signer: PdfSignature["signer"];
  issuer?: string;
  signingTime?: string;
};

async function opensslVerify(der: Buffer, content: Buffer): Promise<CmsResult> {
  const dir = await mkdtemp(join(tmpdir(), "dl-pdf-sig-"));
  const sigPath = join(dir, "sig.der");
  const contentPath = join(dir, "content.bin");
  const signerPath = join(dir, "signer.pem");
  const opts = { timeout: OPENSSL_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 };
  try {
    await Promise.all([writeFile(sigPath, der), writeFile(contentPath, content)]);
    const [verify, printed] = await Promise.allSettled([
      run("openssl", ["cms", "-verify", "-inform", "DER", "-binary", "-noverify", "-in", sigPath, "-content", contentPath, "-signer", signerPath, "-out", process.platform === "win32" ? "NUL" : "/dev/null"], opts),
      run("openssl", ["cms", "-cmsout", "-print", "-noout", "-inform", "DER", "-in", sigPath], opts)
    ]);

    const signer = await readSigner(signerPath);
    const signingTime = printed.status === "fulfilled" ? cmsSigningTime(printed.value.stdout) : undefined;
    if (verify.status === "rejected") {
      return { ok: false, reason: `CMS signature did not verify${opensslError(verify.reason)}`, signer: signer?.signer ?? null, issuer: signer?.issuer, signingTime };
    }
    if (!signer) return { ok: false, reason: "No signer certificate in signature", signer: null, signingTime };
    return { ok: true, signer: signer.signer, issuer: signer.issuer, signingTime };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function opensslError(error: unknown): string {
  const e = error as { killed?: boolean; code?: unknown; stderr?: string };
  if (e?.killed) return " (openssl timed out)";
  if (e?.code === "ENOENT") return " (openssl not installed)";
  const line = e?.stderr?.split("\n").map((l) => l.trim()).find(Boolean);
  return line ? ` (${line.slice(0, 200)})` : "";
}

async function readSigner(path: string): Promise<{ signer: NonNullable<PdfSignature["signer"]>; issuer?: string } | null> {
  const pem = await readFile(path, "utf8").catch(() => "");
  const first = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/)?.[0];
  if (!first) return null;
  try {
    const cert = new X509Certificate(first);
    const subject = parseDn(cert.subject);
    const issuer = parseDn(cert.issuer);
    return {
      signer: { ...(subject.O ? { organisation: subject.O } : {}), ...(subject.CN ? { commonName: subject.CN } : {}) },
      ...(issuer.CN ? { issuer: issuer.CN } : {})
    };
  } catch {
    return null;
  }
}

/** Node prints DNs one `KEY=value` per line; the first occurrence of each key wins. */
function parseDn(dn: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of dn.split("\n")) {
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!(key in out)) out[key] = line.slice(eq + 1).trim();
  }
  return out;
}

/** Reads `signingTime` from `openssl cms -cmsout -print` (UTCTIME/GENERALIZEDTIME, e.g. "Oct 11 10:00:00 2026 GMT"). */
function cmsSigningTime(printed: string): string | undefined {
  const m = printed.match(/signingTime[\s\S]{0,200}?(?:UTCTIME|GENERALIZEDTIME):([^\n]+)/);
  if (!m) return undefined;
  const date = new Date(m[1].trim().replace(/\s+GMT$/, " UTC"));
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** Reads the signature dictionary's `/M (D:YYYYMMDDHHmmss+05'30')`. */
function pdfSigningTime(window: string): string | undefined {
  const m = window.match(/\/M\s*\(D:(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?(?:([Zz+\-])(\d{2})?'?(\d{2})?'?)?\)/);
  if (!m) return undefined;
  const [, y, mo, da, h = "00", mi = "00", s = "00", sign, oh = "00", om = "00"] = m;
  const offset = !sign || sign.toUpperCase() === "Z" ? "Z" : `${sign}${oh}:${om}`;
  const date = new Date(`${y}-${mo}-${da}T${h}:${mi}:${s}${offset}`);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}
