import assert from "node:assert/strict";
import { test } from "node:test";
import { sharedDocuments } from "../../apps/verification-api/src/modules/worker-cases/digilocker-documents";

test("reads type and number from DigiLocker document URIs", () => {
  const docs = sharedDocuments({ data: [
    { uri: "in.gov.pan-PANCR-ABCDE1234F", name: "PAN Verification Record", issuer: "Income Tax Department" },
    { uri: "in.gov.transport-DRVLC-KA01-20190001234", doctype: "DRVLC", issuer: "Transport Department" },
    { uri: "in.gov.uidai-ADHAR-xxxxxxxx1234", doctype: "ADHAR" }
  ] });
  assert.deepEqual(docs.map((doc) => [doc.doctype, doc.number]), [["PANCR", "ABCDE1234F"], ["DRVLC", "KA0120190001234"], ["ADHAR", "XXXXXXXX1234"]]);
  assert.equal(docs[0].issuer, "Income Tax Department");
});

test("finds the list under common keys and ignores unknown shapes", () => {
  assert.equal(sharedDocuments({ data: { documents: [{ file_id: "in.gov.transport-RVCER-KA01AB1234" }] } })[0].number, "KA01AB1234");
  assert.deepEqual(sharedDocuments({ data: { status: "ok" } }), []);
  assert.deepEqual(sharedDocuments(null), []);
});

test("a type given without a matching URI has no number", () => {
  const [doc] = sharedDocuments({ data: [{ doc_type: "pancr", uri: "something-else" }] });
  assert.equal(doc.doctype, "PANCR");
  assert.equal(doc.number, undefined);
});
