import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { isTrustedDigiLockerSigner, verifyPdfSignature } from "../../apps/verification-api/src/modules/worker-cases/digilocker/pdf-signature";
import { pdfText, trimForExtraction } from "../../apps/verification-api/src/modules/worker-cases/digilocker/pdf-text";

const CONTENTS_HEX_LENGTH = 16_384;
let dir = "";

before(() => {
  dir = mkdtempSync(join(tmpdir(), "digilocker-pdf-test-"));
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"),
    "-subj", "/C=IN/O=NATIONAL E-GOVERNANCE DIVISION/CN=DS TEST SIGNER"
  ], { stdio: "ignore" });
});

after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** A PDF-shaped byte string with a signature dictionary, signed over its ByteRange like TCPDF does. */
function signedPdf(): Buffer {
  const placeholder = "/ByteRange [0 0000000000 0000000000 0000000000]";
  const head = "%PDF-1.4\n1 0 obj\n<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /adbe.pkcs7.detached "
    + `${placeholder} /M (D:20260115103000+05'30') /Contents <`;
  const tail = "> >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n";
  const gapStart = head.length - 1; // the "<"
  const gapEnd = head.length + CONTENTS_HEX_LENGTH + 1; // just after the ">"
  const total = gapEnd + tail.length - 1;
  const pad = (n: number) => String(n).padEnd(10, " ");
  const byteRange = `/ByteRange [0 ${pad(gapStart)} ${pad(gapEnd)} ${pad(total - gapEnd)}]`;
  assert.equal(byteRange.length, placeholder.length);

  const before = Buffer.from(head.replace(placeholder, byteRange).slice(0, -1), "latin1");
  const afterGap = Buffer.from(tail.slice(1), "latin1");
  const contentPath = join(dir, "content.bin");
  const sigPath = join(dir, "sig.der");
  writeFileSync(contentPath, Buffer.concat([before, afterGap]));
  execFileSync("openssl", [
    "cms", "-sign", "-binary", "-in", contentPath, "-signer", join(dir, "cert.pem"),
    "-inkey", join(dir, "key.pem"), "-outform", "DER", "-out", sigPath
  ]);
  const hex = readFileSync(sigPath).toString("hex").toUpperCase().padEnd(CONTENTS_HEX_LENGTH, "0");
  assert.equal(hex.length, CONTENTS_HEX_LENGTH);
  const pdf = Buffer.concat([before, Buffer.from(`<${hex}>`, "latin1"), afterGap]);
  assert.equal(pdf.length, total);
  return pdf;
}

test("a correctly signed PDF verifies and names the signer", async () => {
  const sig = await verifyPdfSignature(signedPdf());
  assert.equal(sig.reason, undefined);
  assert.equal(sig.valid, true);
  assert.equal(sig.coversWholeFile, true);
  assert.deepEqual(sig.signer, { organisation: "NATIONAL E-GOVERNANCE DIVISION", commonName: "DS TEST SIGNER" });
  assert.equal(sig.issuer, "DS TEST SIGNER");
  assert.match(sig.signedAt ?? "", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(isTrustedDigiLockerSigner(sig), true);
});

test("changing one signed byte breaks the signature", async () => {
  const pdf = signedPdf();
  pdf[7] = "5".charCodeAt(0); // %PDF-1.4 -> %PDF-1.5
  const sig = await verifyPdfSignature(pdf);
  assert.equal(sig.valid, false);
  assert.match(sig.reason ?? "", /did not verify/);
  assert.equal(isTrustedDigiLockerSigner(sig), false);
});

test("bytes appended after the signed range make it invalid", async () => {
  const pdf = Buffer.concat([signedPdf(), Buffer.from("1 0 obj\n<< /Evil true >>\nendobj\n", "latin1")]);
  const sig = await verifyPdfSignature(pdf);
  assert.equal(sig.coversWholeFile, false);
  assert.equal(sig.valid, false);
  assert.equal(sig.signer?.organisation, "NATIONAL E-GOVERNANCE DIVISION");
  assert.match(sig.reason ?? "", /whole file/);
});

test("garbage and unsigned input are invalid without throwing", async () => {
  for (const input of [
    Buffer.alloc(0),
    Buffer.from("not a pdf at all"),
    Buffer.from("%PDF-1.4\n/ByteRange [0 10 999999 5] /Contents <00>"),
    Buffer.from("%PDF-1.4\n/ByteRange [0 9 20 3] /Contents <ZZZZ>xxxxxxxxxxxx"),
    Buffer.from("%PDF-1.4 /ByteRange [0 9 15 4]<3003020100>abcd")
  ]) {
    const sig = await verifyPdfSignature(input);
    assert.equal(sig.valid, false);
    assert.ok(sig.reason);
  }
  assert.equal((await verifyPdfSignature(Buffer.from("%PDF-1.4"))).reason, "No signature");
});

test("only listed organisations are trusted, and only when valid", () => {
  const base = { valid: true, coversWholeFile: true };
  assert.equal(isTrustedDigiLockerSigner({ ...base, signer: { organisation: "National e-Governance Division" } }), true);
  assert.equal(isTrustedDigiLockerSigner({ ...base, signer: { organisation: "Ministry of Road Transport & Highways" } }), true);
  assert.equal(isTrustedDigiLockerSigner({ ...base, signer: { organisation: "Some Other Org" } }), false);
  assert.equal(isTrustedDigiLockerSigner({ ...base, signer: null }), false);
  assert.equal(isTrustedDigiLockerSigner({ ...base, valid: false, signer: { organisation: "NATIONAL E-GOVERNANCE DIVISION" } }), false);
});

test("trimForExtraction keeps identity fields and drops address, relation, blood group and notes", () => {
  const text = [
    "Driving Licence",
    "Name",
    ":",
    "RAVI KUMAR",
    "License No.",
    ":",
    "KA0120190001234",
    "S/W/D",
    ":",
    "SURESH KUMAR",
    "DOB",
    ":",
    "01-01-1990",
    "Blood Group",
    ":",
    "O+",
    "Present Address",
    ":",
    "12 MG ROAD BENGALURU",
    "KARNATAKA 560001",
    "Permanent Address : 12 MG ROAD BENGALURU",
    "Date of Issue",
    ":",
    "10-02-2019",
    "Date of Expiry",
    ":",
    "09-02-2039",
    "Authorization to Drive",
    ":",
    "LMV, MCWG",
    "Issuing Authority : RTO BENGALURU CENTRAL",
    "Note: This document is generated from DigiLocker and is valid under the IT Act."
  ].join("\n");
  const out = trimForExtraction(text);
  for (const kept of ["Name", "RAVI KUMAR", "License No.", "KA0120190001234", "DOB", "01-01-1990", "Date of Issue", "10-02-2019", "Date of Expiry", "09-02-2039", "LMV, MCWG", "Issuing Authority : RTO BENGALURU CENTRAL"]) {
    assert.ok(out.split("\n").includes(kept), `expected "${kept}" to be kept`);
  }
  for (const gone of ["S/W/D", "SURESH", "Blood Group", "O+", "Address", "MG ROAD", "560001", "Note", "IT Act"]) {
    assert.ok(!out.includes(gone), `expected "${gone}" to be dropped`);
  }
  assert.ok(!out.split("\n").includes(":"));
});

test("trimForExtraction drops chassis and engine numbers on an RC", () => {
  const out = trimForExtraction("Registration Number\n:\nKA01AB1234\nChasis Number\n:\nMA3XXXX\nEngine Number\n:\nK12MXXXX\nOwner Name\n:\nRAVI KUMAR\nRegistration Date\n:\n05-03-2021");
  assert.equal(out, "Registration Number\nKA01AB1234\nOwner Name\nRAVI KUMAR\nRegistration Date\n05-03-2021");
});

/** A minimal valid one-page PDF with two lines of text and a correct xref table. */
function tinyPdf(): Buffer {
  const stream = "BT /F1 12 Tf 72 720 Td (License No.) Tj 0 -20 Td (KA0120190001234) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

test("pdfText extracts the text of a real PDF, one line per baseline", async () => {
  assert.equal(await pdfText(tinyPdf()), "License No.\nKA0120190001234");
});
