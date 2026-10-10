import "reflect-metadata";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";

import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import request from "supertest";
import { ProviderCallService } from "../../apps/verification-api/src/modules/usage/provider-call.service";
import { providerCallContext } from "../../apps/verification-api/src/modules/usage/provider-call.context";
import { VerificationStore } from "../../apps/verification-api/src/modules/verifications/verification.repository";
import { withTenantScope } from "../../apps/verification-api/src/common/database/tenant-prisma";
import { hashPortalPassword } from "../../apps/verification-api/src/modules/portal-auth/password";

let app: INestApplication, db: PrismaClient;
const { createSurepassMock } = require(resolve(process.cwd(), "tools/surepass-mock/server.cjs"));
let provider: { start(): Promise<{ baseUrl: string }>; stop(): Promise<void>; setScenario(mode: string): void; state(): { totalCalls: number } };
let partnerA: any, partnerB: any, packageCode: string;
let providerCalls = 0;
let mode: "success" | "negative" | "malformed" | "rejected" | "server_error" | "manual" | "throttled_once" = "success";
let modeCalls = 0;
const tag = randomUUID().replaceAll("-", "");
const adminKey = `test_admin_${tag}`;
const period = { from: "2026-01-01", to: "2027-01-01" };
const scopes = ["packages:read", "applications:write", "applications:read", "verifications:retry", "verifications:review", "usage:read", "audit:read", "digilocker:write", "aadhaar:read", "aadhaar:write"];
const api = () => request(app.getHttpServer());
const owned = (owner: any, operationKey: string, action: () => Promise<any>) => providerCallContext.run({ tenantId: owner.tenant.id, clientId: owner.client.id, apiKeyId: owner.apiKey.id, operationKey }, action);
async function eventually<T>(read: () => Promise<T>, accept: (value: T) => boolean, timeout = 15000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (true) { const result = await read(); if (accept(result)) return result; if (Date.now() >= deadline) throw new Error(`Timed out waiting for state: ${JSON.stringify(result)}`); await new Promise(resolve => setTimeout(resolve, 30)); }
}
async function createCase(owner: any, code = packageCode) {
  const response = await api().post("/v1/applications").set("x-api-key", owner.rawKey).send({ packageCode: code, personal: { panNumber: "ABCDE1234F", nameAsAadhaar: "Test Worker", submittedAddress: "Test Address" }, consent: { granted: true } });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body;
}
async function awaitCase(id: string, states = ["VERIFIED", "VERIFICATION_FAILED", "MANUAL_REVIEW"]) {
  return eventually(() => db.application.findUniqueOrThrow({ where: { id }, include: { verifications: true, verificationCard: true } }), row => states.includes(row.status));
}
async function usage(owner = partnerA) {
  const response = await api().get("/v1/usage").set("x-api-key", owner.rawKey).query(period);
  assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body;
}
function setMode(next: typeof mode) { mode = next; provider.setScenario(next); }
const sent = () => provider.state().totalCalls;

before(async () => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (!databaseUrl || !/test/i.test(new URL(databaseUrl).pathname)) throw new Error("TEST_DATABASE_URL must name a dedicated test database; tests never reset production data");
  if (!process.env.TEST_REDIS_URL) throw new Error("TEST_REDIS_URL is required for the dedicated queue test instance");
  const redis = new URL(process.env.TEST_REDIS_URL);
  process.env.DATABASE_URL = databaseUrl;
  process.env.REDIS_HOST = redis.hostname; process.env.REDIS_PORT = redis.port || "6379";
  process.env.NODE_ENV = "production"; process.env.ENABLE_INTERNAL_ROUTES = "false";
  process.env.ADMIN_API_KEY = adminKey; process.env.PORTAL_AUTH_TOKEN_SECRET = "test_only_secret_longer_than_32_characters";
  process.env.THROTTLE_LIMIT = "10000"; process.env.PARTNER_RATE_LIMIT = "10000"; process.env.SUREPASS_BEARER_TOKEN = "test_only_fake_token";
  process.env.SUREPASS_TIMEOUT_MS = "1000";
  execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy"], { env: process.env, stdio: "pipe" });
  db = new PrismaClient();
  provider = createSurepassMock({ token: "test_only_fake_token" });
  const { baseUrl } = await provider.start();
  process.env.SUREPASS_BASE_URL = baseUrl;
  const { AppModule } = await import("../../apps/verification-api/src/app.module");
  const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = module.createNestApplication(); app.useLogger(false); await app.init();
  for (const suffix of ["a", "b"]) {
    const response = await api().post("/admin/partners").set("x-admin-key", adminKey).send({ tenantSlug: `test_${tag}_${suffix}`, tenantName: `Partner ${suffix}`, clientCode: "SAME_CODE", clientName: `Client ${suffix}`, scopes });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    if (suffix === "a") partnerA = response.body; else partnerB = response.body;
  }
  packageCode = `TEST_PAN_${tag}`;
  await db.verificationPackage.create({ data: { id: `pkg_${tag}`, code: packageCode.toUpperCase(), version: 1, name: "Test identity", checks: [{ type: "PAN", mode: "REQUIRED", execution: "AUTO" }] } });
});
after(async () => { if (app) await app.close(); if (db) await db.$disconnect(); if (provider) await provider.stop(); });

test("provisioning returns raw keys once and listings never expose digests", async () => {
  assert.ok(partnerA.rawKey.startsWith("gv_"));
  assert.equal(partnerA.apiKey.keyHash, undefined);
  const list = await api().get("/admin/partners").set("x-admin-key", adminKey);
  assert.equal(list.status, 200); assert.ok(!JSON.stringify(list.body).includes(partnerA.rawKey)); assert.ok(!JSON.stringify(list.body).includes('"keyHash"'));
  const key = await db.apiKey.findUniqueOrThrow({ where: { id: partnerA.apiKey.id } });
  assert.notEqual(key.keyHash, partnerA.rawKey); assert.equal(key.keyHash.length, 64);
});
test("missing/invalid admin and partner credentials fail closed", async () => {
  assert.equal((await api().get("/admin/usage")).status, 401);
  assert.equal((await api().get("/admin/usage").set("x-admin-key", "wrong")).status, 401);
  assert.equal((await api().get("/v1/usage")).status, 401);
  assert.equal((await api().get("/v1/usage").set("x-api-key", "wrong")).status, 401);
  const before = sent();
  assert.equal((await api().post("/applications").send({})).status, 403);
  assert.equal(sent(), before);
});
test("scope and payload failures never dispatch or bill", async () => {
  const issued = await api().post(`/admin/clients/${partnerA.client.id}/keys`).set("x-admin-key", adminKey).send({});
  assert.deepEqual(issued.body.apiKey.scopes, ["packages:read"]);
  const before = sent();
  assert.equal((await api().get("/v1/usage").set("x-api-key", issued.body.rawKey)).status, 403);
  assert.equal((await api().post("/v1/applications").set("x-api-key", issued.body.rawKey).send({})).status, 403);
  assert.equal((await api().post("/v1/applications").set("x-api-key", partnerA.rawKey).send({ consent: { granted: false } })).status, 400);
  assert.equal(sent(), before);
});
test("confirmed digital work is counted once per successful provider call", async () => {
  setMode("success"); const before = (await usage()).totalSuccessfulApiCalls;
  const created = await createCase(partnerA), done = await awaitCase(created.id);
  assert.equal(done.status, "VERIFIED"); assert.equal(done.verificationCard?.status, "ACTIVE");
  const report = await usage(); assert.equal(report.totalSuccessfulApiCalls, before + 1);
  assert.equal(report.totalBillable, report.totalSuccessfulApiCalls); assert.ok(report.totalVerifiedChecks >= 1);
  const row = await db.providerCall.findFirstOrThrow({ where: { verificationId: done.verifications[0].id } });
  assert.equal(row.clientId, partnerA.client.id); assert.equal(row.tenantId, partnerA.tenant.id); assert.equal(row.apiKeyId, partnerA.apiKey.id);
  assert.equal(row.state, "SUCCESS"); assert.equal(row.operation, "/api/v1/pan/pan-comprehensive");
  assert.equal((await api().post(`/v1/verifications/${done.verifications[0].id}/retry`).set("x-api-key", partnerA.rawKey)).status, 400);
});
test("two organizations cannot read, retry, decide or aggregate each other's cases", async () => {
  setMode("success"); const foreign = await createCase(partnerB); const done = await awaitCase(foreign.id);
  const key = partnerA.rawKey, id = done.verifications[0].id, before = sent();
  assert.equal((await api().get(`/v1/applications/${foreign.id}/verifications`).set("x-api-key", key)).status, 404);
  assert.equal((await api().post(`/v1/verifications/${id}/retry`).set("x-api-key", key)).status, 404);
  assert.equal((await api().post(`/v1/verifications/${id}/decision`).set("x-api-key", key).send({ decision: "FAILED", note: "Not ours" })).status, 404);
  const report = await api().get("/v1/usage").set("x-api-key", key).query({ ...period, tenantId: partnerB.tenant.id, clientId: partnerB.client.id });
  assert.equal(report.status, 200); assert.ok(report.body.partners.every((row: any) => row.clientId === partnerA.client.id));
  const audits = await api().get("/v1/audit-logs").set("x-api-key", key).query({ clientId: partnerB.client.id });
  assert.equal(audits.status, 200); assert.ok(audits.body.logs.every((row: any) => row.clientId === partnerA.client.id));
  assert.equal((await db.verification.findUniqueOrThrow({ where: { id } })).status, "VERIFIED"); assert.equal(sent(), before);
});
test("schema-derived scoped reads and aggregates cannot escape with OR or foreign IDs", async () => {
  const a = withTenantScope(db, { tenantId: partnerA.tenant.id, clientId: partnerA.client.id });
  const foreign = await db.application.findFirstOrThrow({ where: { clientId: partnerB.client.id } });
  assert.equal(await a.application.findUnique({ where: { id: foreign.id } }), null);
  assert.equal(await a.application.count({ where: { OR: [{ clientId: partnerB.client.id }, { tenantId: partnerB.tenant.id }] } }), 0);
  assert.ok((await a.providerCall.groupBy({ by: ["clientId"], _count: true })).every(row => row.clientId === partnerA.client.id));
  await assert.rejects(a.application.update({ where: { id: foreign.id }, data: { status: "VERIFICATION_FAILED" } }));
  await assert.rejects(a.application.updateMany({ data: { tenantId: partnerB.tenant.id } }));
  assert.equal((await db.application.findUniqueOrThrow({ where: { id: foreign.id } })).status, "VERIFIED");
});
test("ownership mismatches are rejected before dispatch and by database constraints", async () => {
  const calls = app.get(ProviderCallService), before = sent();
  const b = await db.application.findFirstOrThrow({ where: { clientId: partnerB.client.id }, include: { verifications: true } });
  await assert.rejects(providerCallContext.run({ tenantId: partnerA.tenant.id, clientId: partnerA.client.id, applicationId: b.id, verificationId: b.verifications[0].id, operationKey: `bad_${tag}` }, () => calls.dispatch("surepass", "/pan", async () => { providerCalls++; return Response.json({ success: true, data: {} }); })));
  assert.equal(sent(), before);
  await assert.rejects(db.providerCall.create({ data: { id: `bad_${tag}`, tenantId: partnerA.tenant.id, clientId: partnerB.client.id, operationKey: `bad_db_${tag}`, provider: "surepass", operation: "/pan" } }));
});
test("concurrent duplicate dispatch sends one provider request and creates one ledger row", async () => {
  const calls = app.get(ProviderCallService), key = `concurrent_${tag}`; let sends = 0;
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => owned(partnerA, key, () => calls.dispatch("fake", "/unit", async () => { sends++; await new Promise(r => setTimeout(r, 50)); return Response.json({ success: true, data: {} }); }))));
  assert.equal(sends, 1); assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(await db.providerCall.count({ where: { operationKey: `${key}:fake:/unit` } }), 1);
});
test("ambiguous outcomes are visible for reconciliation and are never automatically billed or retried", async () => {
  for (const next of ["malformed", "server_error"] as const) {
    setMode(next); const before = (await usage()).totalSuccessfulApiCalls, sends = sent();
    const created = await createCase(partnerA), done = await awaitCase(created.id);
    assert.equal(done.status, "MANUAL_REVIEW"); assert.equal(done.verificationCard, null);
    assert.equal((await usage()).totalSuccessfulApiCalls, before); assert.equal(sent(), sends + 1);
    const call = await db.providerCall.findFirstOrThrow({ where: { verificationId: done.verifications[0].id } }); assert.equal(call.state, "UNKNOWN");
    assert.equal((await api().post(`/v1/verifications/${done.verifications[0].id}/retry`).set("x-api-key", partnerA.rawKey)).status, 400);
  }
});
test("known provider rejection does not count as successful work", async () => {
  setMode("rejected"); const before = (await usage()).totalSuccessfulApiCalls;
  const done = await awaitCase((await createCase(partnerA)).id);
  assert.equal(done.status, "VERIFICATION_FAILED"); assert.equal(done.verificationCard, null);
  assert.equal((await usage()).totalSuccessfulApiCalls, before);
});
test("rate-limited request followed by successful retry counts exactly one success", async () => {
  setMode("throttled_once"); const before = (await usage()).totalSuccessfulApiCalls;
  const created = await createCase(partnerA); const done = await awaitCase(created.id, ["VERIFIED"]);
  assert.equal((await usage()).totalSuccessfulApiCalls, before + 1);
  const calls = await db.providerCall.findMany({ where: { verificationId: done.verifications[0].id } });
  assert.equal(calls.filter(c => c.state === "SUCCESS").length, 1); assert.equal(calls.filter(c => c.state === "REJECTED").length, 1);
  assert.equal(done.verifications[0].attemptCount, 2);
});
test("negative verification verdict is paid successful API work, not a passed check", async () => {
  const calls = app.get(ProviderCallService), before = (await usage()).totalSuccessfulApiCalls;
  await owned(partnerA, `negative_${tag}`, () => calls.dispatch("fake", "/match", async () => Response.json({ success: true, data: { match_status: false } })));
  assert.equal((await usage()).totalSuccessfulApiCalls, before + 1);
});
test("session entry point is metered under the authenticated partner", async () => {
  setMode("success"); const before = (await usage()).totalSuccessfulApiCalls;
  const response = await api().post("/v1/digilocker/initialize").set("x-api-key", partnerA.rawKey).send({ data: { signup_flow: true } });
  assert.equal(response.status, 201, JSON.stringify(response.body)); assert.equal((await usage()).totalSuccessfulApiCalls, before + 1);
  const row = await db.providerCall.findFirstOrThrow({ where: { clientId: partnerA.client.id, operation: "/api/v1/digilocker/initialize" } });
  assert.equal(row.apiKeyId, partnerA.apiKey.id);
});
test("finalized ledger evidence cannot be changed or deleted", async () => {
  const row = await db.providerCall.findFirstOrThrow({ where: { clientId: partnerA.client.id, state: "SUCCESS" } });
  await assert.rejects(db.providerCall.update({ where: { id: row.id }, data: { state: "REJECTED" } }));
  await assert.rejects(db.providerCall.update({ where: { id: row.id }, data: { clientId: partnerB.client.id } }));
  await assert.rejects(db.providerCall.delete({ where: { id: row.id } }));
});
test("usage periods reject malformed/reversed dates and exclude calls on the end boundary", async () => {
  for (const query of [{ from: "junk", to: "2027-01-01" }, { from: "2026-02-30", to: "2027-01-01" }, { from: "2026-11-01", to: "2026-01-01" }]) assert.equal((await api().get("/admin/usage").set("x-admin-key", adminKey).query(query)).status, 400);
  const when = new Date("2026-05-01T00:00:00Z"), id = `boundary_${tag}`;
  await db.providerCall.create({ data: { id, tenantId: partnerB.tenant.id, clientId: partnerB.client.id, operationKey: id, provider: "fake", operation: "/boundary", state: "SUCCESS", httpStatus: 200, completedAt: when, startedAt: when } });
  const excluded = await api().get("/v1/usage").set("x-api-key", partnerB.rawKey).query({ from: "2026-04-01", to: "2026-05-01" }); assert.equal(excluded.body.totalSuccessfulApiCalls, 0);
  const included = await api().get("/v1/usage").set("x-api-key", partnerB.rawKey).query({ from: "2026-05-01", to: "2026-05-02" }); assert.equal(included.body.totalSuccessfulApiCalls, 1);
});
test("concurrent key rotation leaves one replacement; old key immediately fails", async () => {
  const issued = await api().post(`/admin/clients/${partnerA.client.id}/keys`).set("x-admin-key", adminKey).send({ scopes: ["usage:read"], expiresInDays: 30 });
  const results = await Promise.all(Array.from({ length: 4 }, () => api().post(`/admin/keys/${issued.body.apiKey.id}/rotate`).set("x-admin-key", adminKey)));
  assert.equal(results.filter(r => r.status === 201).length, 1); assert.equal(results.filter(r => r.status === 409).length, 3);
  assert.equal((await api().get("/v1/usage").set("x-api-key", issued.body.rawKey)).status, 401);
  const replacement = results.find(r => r.status === 201)!.body;
  assert.equal((await api().get("/v1/usage").set("x-api-key", replacement.rawKey)).status, 200);
  assert.deepEqual(replacement.apiKey.scopes, ["usage:read"]); assert.equal(replacement.apiKey.expiresAt, issued.body.apiKey.expiresAt);
});
test("revocation is idempotent, audited once, and rejects further rotation", async () => {
  const issued = await api().post(`/admin/clients/${partnerA.client.id}/keys`).set("x-admin-key", adminKey).send({ scopes: ["usage:read"] });
  for (let n = 0; n < 2; n++) assert.equal((await api().post(`/admin/keys/${issued.body.apiKey.id}/revoke`).set("x-admin-key", adminKey)).status, 201);
  assert.equal(await db.auditLog.count({ where: { action: "apiKey.revoke", apiKeyId: issued.body.apiKey.id } }), 1);
  assert.equal((await api().get("/v1/usage").set("x-api-key", issued.body.rawKey)).status, 401);
  assert.equal((await api().post(`/admin/keys/${issued.body.apiKey.id}/rotate`).set("x-admin-key", adminKey)).status, 409);
});
test("invalid scope/expiry input is rejected before any key is created", async () => {
  const before = await db.apiKey.count({ where: { clientId: partnerA.client.id } });
  for (const body of [{ scopes: [] }, { scopes: "usage:read" }, { scopes: [123] }, { scopes: ["*"] }, { expiresInDays: 0 }, { expiresInDays: 1.5 }, { expiresInDays: 1000000 }]) assert.equal((await api().post(`/admin/clients/${partnerA.client.id}/keys`).set("x-admin-key", adminKey).send(body)).status, 400);
  assert.equal(await db.apiKey.count({ where: { clientId: partnerA.client.id } }), before);
});
test("audit failure rolls back key rotation, preserving the old credential", async () => {
  const issued = await api().post(`/admin/clients/${partnerA.client.id}/keys`).set("x-admin-key", adminKey).send({ scopes: ["usage:read"] });
  // Dedicated test DB fault injection, targeted to this unique test client only.
  const client = partnerA.client.id; assert.match(client, /^client_[a-f0-9-]+$/);
  await db.$executeRawUnsafe(`CREATE FUNCTION test_fail_rotation_${tag}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."action" = 'apiKey.rotate' AND NEW."clientId" = '${client}' THEN RAISE EXCEPTION 'test audit failure'; END IF; RETURN NEW; END $$`);
  await db.$executeRawUnsafe(`CREATE TRIGGER test_fail_rotation_${tag} BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION test_fail_rotation_${tag}()`);
  const before = await db.apiKey.count({ where: { clientId: client } });
  try {
    assert.equal((await api().post(`/admin/keys/${issued.body.apiKey.id}/rotate`).set("x-admin-key", adminKey)).status, 500);
    assert.equal(await db.apiKey.count({ where: { clientId: client } }), before);
    assert.equal((await db.apiKey.findUniqueOrThrow({ where: { id: issued.body.apiKey.id } })).isActive, true);
    assert.equal((await api().get("/v1/usage").set("x-api-key", issued.body.rawKey)).status, 200);
  } finally {
    await db.$executeRawUnsafe(`DROP TRIGGER test_fail_rotation_${tag} ON "AuditLog"`);
    await db.$executeRawUnsafe(`DROP FUNCTION test_fail_rotation_${tag}()`);
  }
});

test("field evidence returns to the same case for QA and does not increase API billing", async () => {
  const code = `TEST_FIELD_${tag}`;
  await db.verificationPackage.create({ data: { id: `pkg_field_${tag}`, code: code.toUpperCase(), version: 1, name: "Test field", checks: [{ type: "CURRENT_ADDRESS", mode: "REQUIRED", execution: "MANUAL" }] } });
  const a = await createCase(partnerA, code), b = await createCase(partnerB, code);
  const agentId = `agent_${tag}`, email = `agent_${tag}@example.test`, password = "test_password_123";
  await db.portalUser.create({ data: { id: agentId, email, displayName: "Test Agent", passwordHash: await hashPortalPassword(password), role: "FIELD_AGENT", tenantId: partnerA.tenant.id, clientId: partnerA.client.id } });
  const login = await api().post("/v1/portal-auth/login").send({ email, password }); assert.equal(login.status, 201);
  const auth = `Bearer ${login.body.accessToken}`;
  const list = await api().get("/v1/field/tasks").set("authorization", auth); assert.equal(list.status, 200); assert.equal(list.body.available.length, 1);
  const task = list.body.available[0];
  assert.equal(await db.fieldTask.count({ where: { applicationId: b.id } }), 0); // request-scoped sync cannot mutate B
  const before = (await usage()).totalSuccessfulApiCalls;
  assert.equal((await api().post(`/v1/field/tasks/${task.id}/accept`).set("authorization", auth)).status, 201);
  assert.equal((await api().post(`/v1/field/tasks/${task.id}/submit`).set("authorization", auth).send({ outcome: "PERSON_MET", notes: "Evidence for QA" })).status, 201);
  const pending = await db.application.findUniqueOrThrow({ where: { id: a.id }, include: { verificationCard: true, verifications: true } });
  assert.equal(pending.status, "MANUAL_REVIEW"); assert.equal(pending.verificationCard, null);
  assert.equal((await usage()).totalSuccessfulApiCalls, before);
  const decision = await api().post(`/v1/verifications/${pending.verifications[0].id}/decision`).set("x-api-key", partnerA.rawKey).send({ decision: "VERIFIED", note: "QA approved evidence" });
  assert.equal(decision.status, 201); assert.equal(decision.body.status, "VERIFIED"); assert.equal(decision.body.card.status, "ACTIVE");
  assert.equal((await usage()).totalSuccessfulApiCalls, before);
  assert.equal((await api().post(`/v1/field/tasks/${task.id}/accept`).set("authorization", auth)).status, 400);
});
test("disabled organizations cannot use keys, issue new keys or be silently reactivated", async () => {
  await db.client.update({ where: { id: partnerB.client.id }, data: { status: "INACTIVE" } });
  assert.equal((await api().get("/v1/usage").set("x-api-key", partnerB.rawKey)).status, 401);
  assert.equal((await api().post(`/admin/clients/${partnerB.client.id}/keys`).set("x-admin-key", adminKey).send({})).status, 403);
  assert.equal((await api().post("/admin/partners").set("x-admin-key", adminKey).send({ tenantSlug: partnerB.tenant.slug, tenantName: "Changed", clientCode: partnerB.client.code, clientName: "Changed" })).status, 403);
  assert.equal((await db.client.findUniqueOrThrow({ where: { id: partnerB.client.id } })).status, "INACTIVE");
});
