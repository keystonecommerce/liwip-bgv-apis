import "reflect-metadata";
import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyProviderResponse, ProviderCallService } from "../../apps/verification-api/src/modules/usage/provider-call.service";
import { providerCallContext } from "../../apps/verification-api/src/modules/usage/provider-call.context";
import { parseUsageDate, usagePeriod } from "../../apps/verification-api/src/modules/usage/usage.service";
import { applicationStatusForChecks } from "../../apps/verification-api/src/domain/application-status";
import { normalizeScopes, generateApiKey } from "../../apps/verification-api/src/common/security/api-key.util";

for (const [label, httpStatus, body, expected] of [
  ["confirmed success", 200, { success: true, data: {} }, "SUCCESS"],
  ["negative match is successful work", 200, { success: true, data: { match_status: false } }, "SUCCESS"],
  ["success flag alone is insufficient", 200, { success: true }, "UNKNOWN"],
  ["malformed success", 200, null, "UNKNOWN"],
  ["missing success flag", 200, { data: {} }, "UNKNOWN"],
  ["known business rejection", 200, { success: false }, "REJECTED"],
  ["invalid credentials", 401, { success: true, data: {} }, "REJECTED"],
  ["throttling", 429, { success: false }, "REJECTED"],
  ["server failure", 500, { success: false }, "UNKNOWN"],
  ["redirect", 302, { success: true, data: {} }, "UNKNOWN"],
] as const) test(label, () => assert.equal(classifyProviderResponse(httpStatus, body), expected));

test("status calculation blocks empty, incomplete, and pending-QA cases", () => {
  assert.equal(applicationStatusForChecks([]), "PENDING_VERIFICATION");
  assert.equal(applicationStatusForChecks(["VERIFIED", "QUEUED"]), "VERIFICATION_IN_PROGRESS");
  assert.equal(applicationStatusForChecks(["VERIFIED", "MANUAL_REVIEW"]), "MANUAL_REVIEW");
  assert.equal(applicationStatusForChecks(["FAILED", "MANUAL_REVIEW"]), "VERIFICATION_FAILED");
  assert.equal(applicationStatusForChecks(["VERIFIED", "VERIFIED"]), "VERIFIED");
});
test("usage windows validate dates and use an exclusive end", () => {
  assert.throws(() => parseUsageDate("junk"));
  assert.throws(() => parseUsageDate("2026-02-30"));
  assert.throws(() => usagePeriod({ from: new Date("2026-02-01"), to: new Date("2026-01-01") }));
  assert.throws(() => usagePeriod({ from: new Date("2024-01-01"), to: new Date("2026-01-01") }));
  const period = usagePeriod({ to: new Date("2026-10-01") });
  assert.equal(period.to.getTime() - period.from.getTime(), 30 * 86400000);
});
test("keys store a digest and scopes fail closed", () => {
  const first = generateApiKey(), second = generateApiKey();
  assert.notEqual(first.raw, second.raw);
  assert.equal(first.keyHash.length, 64);
  assert.ok(!first.keyHash.includes(first.raw));
  assert.deepEqual(normalizeScopes(undefined), ["packages:read"]);
  for (const scopes of [[], [""], ["*"], [123], "applications:read", null]) assert.throws(() => normalizeScopes(scopes as any));
});

function fakeLedger(options: { failStart?: boolean; failFinish?: boolean; existing?: boolean } = {}) {
  const rows: any[] = [];
  const tx = { client: { findFirst: async () => ({ id: "client_a" }) }, providerCall: {
    findUnique: async () => options.existing ? { id: "existing" } : null,
    create: async ({ data }: any) => { if (options.failStart) throw new Error("Database unavailable"); const row = { ...data }; rows.push(row); return row; },
  } };
  const db = { $transaction: async (fn: any) => fn(tx), providerCall: { update: async ({ data }: any) => { if (options.failFinish) throw new Error("Database unavailable"); Object.assign(rows[0], data); return rows[0]; } } };
  return { rows, service: new ProviderCallService(db as any) };
}
const owned = <T>(action: () => Promise<T>) => providerCallContext.run({ tenantId: "tenant_a", clientId: "client_a", operationKey: "operation_a" }, action);
test("database failure before dispatch never calls the provider", async () => {
  const { service } = fakeLedger({ failStart: true }); let sends = 0;
  await assert.rejects(owned(() => service.dispatch("fake", "/pan", async () => { sends++; return Response.json({ success: true, data: {} }); })));
  assert.equal(sends, 0);
});
test("duplicate operation never calls the provider", async () => {
  const { service } = fakeLedger({ existing: true }); let sends = 0;
  await assert.rejects(owned(() => service.dispatch("fake", "/pan", async () => { sends++; return Response.json({ success: true, data: {} }); })), { code: "PROVIDER_OUTCOME_UNKNOWN" });
  assert.equal(sends, 0);
});
test("timeout is preserved as unknown and blocks automatic replay", async () => {
  const { service, rows } = fakeLedger();
  await assert.rejects(owned(() => service.dispatch("fake", "/pan", async () => { throw new Error("Timeout"); })), { code: "PROVIDER_OUTCOME_UNKNOWN" });
  assert.equal(rows[0].state, "UNKNOWN");
});
test("a successful call whose final accounting write fails stays STARTED", async () => {
  const { service, rows } = fakeLedger({ failFinish: true }); let sends = 0;
  await assert.rejects(owned(() => service.dispatch("fake", "/pan", async () => { sends++; return Response.json({ success: true, data: {} }); })), { code: "PROVIDER_OUTCOME_UNKNOWN" });
  assert.equal(sends, 1); assert.equal(rows[0].state, "STARTED");
});
test("response metadata is preserved without identity data", async () => {
  const { service, rows } = fakeLedger();
  await owned(() => service.dispatch("fake", "/pan", async () => Response.json({ success: true, data: { client_id: "request_1", full_name: "PRIVATE PERSON", pan_number: "PRIVATE PAN" } })));
  assert.equal(rows[0].state, "SUCCESS"); assert.equal(rows[0].providerRequestId, "request_1");
  assert.ok(!JSON.stringify(rows).includes("PRIVATE"));
});
