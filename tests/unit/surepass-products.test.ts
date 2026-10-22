import "reflect-metadata";
import assert from "node:assert/strict";
import { test } from "node:test";
import { isCheckAvailable, productForPath } from "../../apps/verification-api/src/integrations/surepass/products";
import { checkContracts } from "../../apps/verification-api/src/integrations/surepass/check-registry";
import { challanStatus } from "../../apps/verification-api/src/integrations/surepass/checks/vehicle-challan";
import { SurepassProvider } from "../../apps/verification-api/src/integrations/surepass/surepass.provider";
import type { SurepassTransport } from "../../apps/verification-api/src/integrations/surepass/surepass.transport";
import { validateCheck } from "../../apps/verification-api/src/domain/supplementary-checks";
import { applyCheckInput } from "../../apps/verification-api/src/modules/worker-cases/worker-case.inputs";

/** The production account as enabled on 2026-10-15 (no OVSE, face or RC V2). */
const PRODUCTION = "digilocker,pan-comprehensive,driving-license-text,rc-text,voter-id-text,passport-details,employment-history-uan-v2,ecourt-search-v2,rc-challan-advanced,electricity,ocr-aadhaar,ocr-aadhaar-full,ocr-aadhaar-masking,ocr-pan,ocr-license,ocr-passport,name-match,mobile-to-name,prefill-by-mobile,email-check,bank-verification,bank-verification-upi";

function withProducts<T>(list: string, run: () => T): T {
  const previous = process.env.SUREPASS_ENABLED_PRODUCTS;
  process.env.SUREPASS_ENABLED_PRODUCTS = list;
  try { return run(); } finally {
    if (previous === undefined) delete process.env.SUREPASS_ENABLED_PRODUCTS;
    else process.env.SUREPASS_ENABLED_PRODUCTS = previous;
  }
}

test("a path matches its own product, not a longer sibling", () => {
  assert.equal(productForPath("/api/v1/ocr/aadhaar"), "ocr-aadhaar");
  assert.equal(productForPath("/api/v1/ocr/aadhaar-full"), "ocr-aadhaar-full");
  assert.equal(productForPath("/api/v1/bank-verification/"), "bank-verification");
  assert.equal(productForPath("/api/v1/bank-verification/upi-verification"), "bank-verification-upi");
  assert.equal(productForPath("/api/v1/utils/name-matching/"), "name-match");
  assert.equal(productForPath("/api/v1/utility/electricity/operator-code-list"), "electricity");
});

test("unlisted paths under an exact product are not allowed", () => {
  assert.equal(productForPath("/api/v1/bank-verification/upi-advanced-v2"), undefined);
  assert.equal(productForPath("/api/v1/bank-verification/bank-verification-pdf-report"), undefined);
  assert.equal(productForPath("/api/v1/rc/rc-related/challan-details"), undefined);
});

test("folder products still cover their sub-paths", () => {
  assert.equal(productForPath("/api/v1/digilocker/status/abc"), "digilocker");
  assert.equal(productForPath("/api/v1/aadhaar-v4/initialize"), "aadhaar-ovse");
});

test("on production, Aadhaar runs through DigiLocker and the vehicle check through RC Text", () => {
  withProducts(PRODUCTION, () => {
    assert.equal(isCheckAvailable("AADHAAR"), true);
    assert.equal(isCheckAvailable("RC_V2"), true);
    assert.equal(isCheckAvailable("VEHICLE_CHALLAN"), true);
    assert.equal(isCheckAvailable("ELECTRICITY_BILL"), true);
    assert.equal(isCheckAvailable("FACE_LIVENESS"), false);
    assert.equal(isCheckAvailable("FACE_MATCH"), false);
  });
});

test("a check with none of its products enabled is not offered", () => {
  withProducts("pan-comprehensive", () => {
    assert.equal(isCheckAvailable("AADHAAR"), false);
    assert.equal(isCheckAvailable("RC_V2"), false);
    assert.equal(isCheckAvailable("PAN"), true);
    assert.equal(isCheckAvailable("CURRENT_ADDRESS"), true);
  });
});

test("adapters send the documented production requests", () => {
  assert.deepEqual(checkContracts.VEHICLE_CHALLAN.build({ registrationNumber: "MH12DE3456" }, {}), { path: "/api/v1/rc/rc-related/challan-advanced", body: { rc_number: "MH12DE3456" } });
  assert.deepEqual(checkContracts.BANK_ACCOUNT.build({ accountNumber: "219101000000000", ifsc: "BARB0DAMOHA" }, {}), { path: "/api/v1/bank-verification/", body: { id_number: "219101000000000", ifsc: "BARB0DAMOHA", ifsc_details: true } });
  assert.deepEqual(checkContracts.UPI.build({ upiId: "9876543210@ybl" }, {}), { path: "/api/v1/bank-verification/upi-verification", body: { upi_id: "9876543210@ybl" } });
  assert.deepEqual(checkContracts.ELECTRICITY_BILL.build({ consumerNumber: "17000346322745", operatorCode: "MH" }, {}), { path: "/api/v1/utility/electricity/", body: { id_number: "17000346322745", operator_code: "MH" } });
  assert.deepEqual(checkContracts.PREFILL_BY_MOBILE.build({ mobile: "9660912345" }, {}), { path: "/api/v1/prefill/prefill-by-mobile", body: { mobile: "9660912345" } });
  assert.equal(checkContracts.PASSPORT_OCR.build({}, {}).path, "/api/v1/ocr/passport");
});

test("Aadhaar Full OCR sends both sides", () => {
  const side = (name: string) => ({ buffer: Buffer.from("x"), originalname: `${name}.jpg`, mimetype: "image/jpeg" });
  const request = checkContracts.AADHAAR_OCR_FULL.build({}, { front: side("front"), back: side("back") });
  assert.equal(request.path, "/api/v1/ocr/aadhaar-full");
  const form = request.body as FormData;
  assert.ok(form.get("front") && form.get("back"));
  assert.equal(form.get("use_pdf"), null);
});

test("challans: none open passes, open ones go to review", () => {
  assert.equal(challanStatus({ challan_details: [] }), "verified");
  assert.equal(challanStatus({ challan_details: [{ challan_status: "Disposed" }, { challan_status: "Paid" }] }), "verified");
  assert.equal(challanStatus({ challan_details: [{ challan_status: "Disposed" }, { challan_status: "Pending" }] }), "manual_review");
  assert.equal(challanStatus({ challan_details: [{ challan_status: "Court Pending" }] }), "manual_review");
  assert.equal(challanStatus({}), "manual_review");
});

test("challan input is only the vehicle number", () => {
  assert.doesNotThrow(() => validateCheck("VEHICLE_CHALLAN", { registrationNumber: "MH12DE3456" }));
  assert.throws(() => validateCheck("VEHICLE_CHALLAN", { registrationNumber: "MH12DE3456", chassisNumber: "X" }), /Unexpected check field/);
  assert.throws(() => validateCheck("ELECTRICITY_BILL", { consumerNumber: "17000346322745", operatorCode: "mh!" }), /operator code/);
});

test("the worker's electricity bill input is kept with its hyphens", () => {
  const data = applyCheckInput("ELECTRICITY_BILL", { consumerNumber: " 1700-0346 3227 ", operatorCode: "mh" }, { personal: { phone: "9876543210", nameAsAadhaar: "", dateOfBirth: "" } });
  assert.deepEqual(data.addressProof, { consumerNumber: "1700-03463227", operatorCode: "MH" });
});

/** A transport that records the path and answers like Surepass. */
function fakeTransport(data: Record<string, unknown>) {
  const paths: string[] = [];
  const reply = async (path: string) => { paths.push(path); return { statusCode: 200, body: { success: true, status_code: 200, data } }; };
  const transport = { send: reply, request: (request: { path: string }) => reply(request.path) } as unknown as SurepassTransport;
  return { transport, paths };
}

test("the vehicle check calls RC Text when RC V2 is not enabled", async () => {
  const { transport, paths } = fakeTransport({ owner_name: "Ravi Kumar" });
  const provider = new SurepassProvider(transport);
  await withProducts(PRODUCTION, () => provider.verify("RC_V2", { idNumber: "MH12DE3456", name: ["Ravi Kumar"], official: true }));
  await withProducts("rc-v2,rc-text", () => provider.verify("RC_V2", { idNumber: "MH12DE3456", name: ["Ravi Kumar"], official: true }));
  assert.deepEqual(paths, ["/api/v1/rc/rc-full", "/api/v1/rc/rc-v2"]);
});

test("an electricity bill in the worker's name verifies; another name goes to review", async () => {
  const input = { consumerNumber: "17000346322745", operatorCode: "MH", name: ["Ravi Kumar"], official: true };
  assert.equal((await new SurepassProvider(fakeTransport({ full_name: "RAVI KUMAR" }).transport).verify("ELECTRICITY_BILL", input)).status, "verified");
  assert.equal((await new SurepassProvider(fakeTransport({ full_name: "SUNITA DEVI" }).transport).verify("ELECTRICITY_BILL", input)).status, "manual_review");
});
