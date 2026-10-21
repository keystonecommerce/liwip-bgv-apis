import "reflect-metadata";
import assert from "node:assert/strict";
import { test } from "node:test";
import { verifiers } from "../../apps/verification-api/src/integrations/surepass/verifier-registry";
import { SurepassProvider } from "../../apps/verification-api/src/integrations/surepass/surepass.provider";
import type { SurepassTransport } from "../../apps/verification-api/src/integrations/surepass/surepass.transport";

/** A transport that answers every call like Surepass with the given data. */
function provider(data: Record<string, unknown>) {
  const reply = async () => ({ statusCode: 200, body: { success: true, status_code: 200, data } });
  return new SurepassProvider({ send: reply, request: reply } as unknown as SurepassTransport);
}

test("each verifier is registered under its own type", () => {
  for (const [key, verifier] of Object.entries(verifiers)) assert.equal(verifier?.type, key);
});

test("a type without a verifier is refused", async () => {
  await assert.rejects(provider({}).verify("REFERENCE_CHECK", {}), (error: Error & { code?: string }) => error.code === "UNSUPPORTED_VERIFICATION_TYPE");
});

test("court records: no cases passes, any case or a missing list goes to review", async () => {
  const input = { name: "Ravi Kumar", fatherName: "Mohan Kumar", address: "12 MG Road, Pune 411001" };
  assert.equal((await provider({ result: [] }).verify("ECOURTS_SEARCH", input)).status, "verified");
  assert.equal((await provider({ result: [{ case: 1 }] }).verify("ECOURTS_SEARCH", input)).status, "manual_review");
  assert.equal((await provider({}).verify("ECOURTS_SEARCH", input)).status, "manual_review");
});

test("an expired driving licence goes to review even when the name matches", async () => {
  const input = { licenseNumber: "MH1220110012345", dob: "1990-01-01", name: ["Ravi Kumar"], official: true };
  assert.equal((await provider({ name: "RAVI KUMAR", doe: "2099-01-01" }).verify("DRIVING_LICENSE", input)).status, "verified");
  assert.equal((await provider({ name: "RAVI KUMAR", doe: "2001-01-01" }).verify("DRIVING_LICENSE", input)).status, "manual_review");
});

test("checks without a verdict go to review", async () => {
  assert.equal((await provider({ client_id: "x" }).verify("EMPLOYMENT_HISTORY", { uan: "100000000001" })).status, "manual_review");
});
