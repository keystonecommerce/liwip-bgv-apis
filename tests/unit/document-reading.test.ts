import assert from "node:assert/strict";
import { test } from "node:test";
import { readingFrom } from "../../apps/verification-api/src/modules/worker-cases/document-reading";
import { checkedFileType, sniffFileType } from "../../apps/verification-api/src/domain/file-types";

test("a PAN photo pre-fills the PAN; name and date of birth are shown alongside", () => {
  const reading = readingFrom("PAN", { ocr_fields: [{ pan_number: { value: "abcpd 1234e", confidence: 99 }, full_name: { value: " Ravi  Kumar ", confidence: 97 }, dob: { value: "15/08/1994", confidence: 60 } }] });
  assert.deepEqual(reading.fields, { panNumber: "ABCPD1234E" });
  assert.deepEqual(reading.details, { name: "Ravi Kumar", dateOfBirth: "1994-08-15" });
  assert.deepEqual(reading.lowConfidence, [], "only pre-filled fields are flagged");
});

test("a licence photo pre-fills the number and date of birth, flagging what was hard to read", () => {
  const reading = readingFrom("DRIVING_LICENSE", { license_number: { value: "KA01 20190001234", confidence: 88 }, dob: { value: "1994-08-15", confidence: 64 } });
  assert.deepEqual(reading.fields, { licenceNumber: "KA0120190001234", dateOfBirth: "1994-08-15" });
  assert.deepEqual(reading.lowConfidence, ["dateOfBirth"]);
});

test("a passport photo pre-fills the file number", () => {
  const reading = readingFrom("PASSPORT", { ocr_fields: [{ file_num: { value: "BN1061961923456", confidence: 91 }, address: { value: "12 MG Road", confidence: 88 }, pin: { value: "560038", confidence: 93 } }] });
  assert.deepEqual(reading.fields, { fileNumber: "BN1061961923456" });
  assert.equal(reading.details.address, "12 MG Road 560038");
});

test("nothing read gives no fields", () => {
  assert.deepEqual(readingFrom("PAN", { ocr_fields: [] }).fields, {});
  assert.deepEqual(readingFrom("DRIVING_LICENSE", null).fields, {});
  assert.deepEqual(readingFrom("PAN", { ocr_fields: [{ dob: { value: "not a date", confidence: 99 } }] }).details, {});
});

test("file types come from the bytes and must agree with the declared type", () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]);
  assert.equal(sniffFileType(jpeg), "image/jpeg");
  assert.equal(sniffFileType(Buffer.from("%PDF-1.7")), "application/pdf");
  assert.equal(sniffFileType(Buffer.from("hello")), null);
  assert.equal(checkedFileType(jpeg, "image/jpeg; charset=binary", ["image/jpeg"]), "image/jpeg");
  assert.equal(checkedFileType(jpeg, "image/png", ["image/jpeg", "image/png"]), null);
  assert.equal(checkedFileType(jpeg, "image/jpeg", ["image/png"]), null);
});
