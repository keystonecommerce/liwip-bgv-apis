import "reflect-metadata";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { resolve } from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";

import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import request from "supertest";
import { ProviderCallService } from "../../apps/verification-api/src/modules/usage/provider-call.service";
import { providerCallContext } from "../../apps/verification-api/src/modules/usage/provider-call.context";
import { VerificationStore } from "../../apps/verification-api/src/modules/verifications/verification.repository";
import { withTenantScope } from "../../apps/verification-api/src/common/database/tenant-prisma";
import { PartnerProvisioning } from "../../apps/verification-api/src/common/security/partner-provisioning";
import { provisionPlatformAdmin } from "../../apps/verification-api/src/modules/admin-access/bootstrap";

let app: INestApplication, db: PrismaClient;
const { createSurepassMock } = require(resolve(process.cwd(), "tools/surepass-mock/server.cjs"));
let provider: { start(): Promise<{ baseUrl: string }>; stop(): Promise<void>; setScenario(mode: string): void; state(): { totalCalls: number } };
let partnerA: any, partnerB: any, packageCode: string;
let providerCalls = 0;
let mode: "success" | "negative" | "malformed" | "rejected" | "server_error" | "manual" | "throttled_once" = "success";
let modeCalls = 0;
const tag = randomUUID().replaceAll("-", "");
const ORIGIN = "https://admin.test.liwip.example";
const COOKIE = "__Host-liwip_admin";
interface Staff { token: string; csrf: string }
let keystone: Staff;
const period = { from: "2026-01-01", to: "2027-01-01" };
const scopes = ["packages:read", "applications:write", "applications:read", "verifications:retry", "verifications:review", "usage:read", "audit:read", "digilocker:write", "aadhaar:read", "aadhaar:write"];
const api = () => request(app.getHttpServer());
const owned = (owner: any, operationKey: string, action: () => Promise<any>) => providerCallContext.run({ tenantId: owner.tenant.id, clientId: owner.client.id, apiKeyId: owner.apiKey.id, operationKey }, action);
async function eventually<T>(read: () => Promise<T>, accept: (value: T) => boolean, timeout = 15000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (true) { const result = await read(); if (accept(result)) return result; if (Date.now() >= deadline) throw new Error(`Timed out waiting for state: ${JSON.stringify(result)}`); await new Promise(resolve => setTimeout(resolve, 30)); }
}
async function createCase(owner: any, code = packageCode, nameAsAadhaar = "Test Worker") {
  const response = await api().post("/v1/applications").set("x-api-key", owner.rawKey).send({ packageCode: code, personal: { panNumber: "ABCDE1234F", nameAsAadhaar, submittedAddress: "Test Address" }, consent: { granted: true } });
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
/** A staff session row for an existing account (sign-in itself is covered by admin-access.test.ts). */
async function staffSession(userId: string): Promise<Staff> {
  const user = await db.portalUser.findUniqueOrThrow({ where: { id: userId } });
  const token = randomBytes(32).toString("base64url");
  await db.staffSession.create({ data: { id: `staff_session_${randomUUID()}`, userId, tokenHash: createHash("sha256").update(token).digest("hex"), sessionVersion: user.sessionVersion, authMethod: "otp", expiresAt: new Date(Date.now() + 3_600_000) } });
  const response = await api().get("/v1/admin/auth/session").set("Cookie", `${COOKIE}=${token}`);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return { token, csrf: response.body.csrfToken };
}
function as(staff: Staff, method: "get" | "post", path: string) {
  let call = api()[method](path).set("Cookie", `${COOKIE}=${staff.token}`).set("Origin", ORIGIN);
  if (method === "post") call = call.set("x-csrf-token", staff.csrf);
  return call;
}
const issueKey = (owner: any, body: Record<string, unknown>) => as(keystone, "post", "/v1/admin/api-keys").send({ programId: owner.client.id, ...body });
const rotateKey = (keyId: string) => as(keystone, "post", `/v1/admin/api-keys/${keyId}/rotate`);
const revokeKey = (keyId: string) => as(keystone, "post", `/v1/admin/api-keys/${keyId}/revoke`);
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
  process.env.ADMIN_AUTH_SECRET = "test_only_admin_auth_secret_longer_than_32";
  process.env.WORKER_TOKEN_SECRET = "test_only_worker_token_secret_longer_than_32";
  process.env.ADMIN_PANEL_ORIGINS = ORIGIN;
  process.env.THROTTLE_LIMIT = "10000"; process.env.PARTNER_RATE_LIMIT = "10000"; process.env.SUREPASS_BEARER_TOKEN = "test_only_fake_token";
  process.env.SUREPASS_TIMEOUT_MS = "1000";
  process.env.MOCK_NAME = "Test Worker"; // the name the mock returns for identity lookups
  execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy"], { env: process.env, stdio: "pipe" });
  db = new PrismaClient();
  provider = createSurepassMock({ token: "test_only_fake_token" });
  const { baseUrl } = await provider.start();
  process.env.SUREPASS_BASE_URL = baseUrl;
  const { AppModule } = await import("../../apps/verification-api/src/app.module");
  const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = module.createNestApplication(); app.useLogger(false); await app.init();
  // Partners are provisioned the way the scripts do it; keys are then managed over HTTP.
  const provisioning = new PartnerProvisioning(db);
  partnerA = await provisioning.createPartner({ tenantSlug: `test_${tag}_a`, tenantName: "Partner a", clientCode: "SAME_CODE", clientName: "Client a", scopes });
  partnerB = await provisioning.createPartner({ tenantSlug: `test_${tag}_b`, tenantName: "Partner b", clientCode: "SAME_CODE", clientName: "Client b", scopes });
  const admin = await provisionPlatformAdmin(db, `keystone-prov-${tag}@example.com`, "Keystone Admin");
  keystone = await staffSession(admin.id);
  packageCode = `TEST_PAN_${tag}`;
  await db.verificationPackage.create({ data: { id: `pkg_${tag}`, code: packageCode.toUpperCase(), version: 1, name: "Test identity", checks: [{ type: "PAN", mode: "REQUIRED", execution: "AUTO" }] } });
});
after(async () => { if (app) await app.close(); if (db) await db.$disconnect(); if (provider) await provider.stop(); });

test("provisioning returns raw keys once and listings never expose digests", async () => {
  assert.ok(partnerA.rawKey.startsWith("gv_"));
  assert.equal(partnerA.apiKey.keyHash, undefined);
  const list = await as(keystone, "get", "/v1/admin/api-keys");
  assert.equal(list.status, 200); assert.ok(!JSON.stringify(list.body).includes(partnerA.rawKey)); assert.ok(!JSON.stringify(list.body).includes('"keyHash"'));
  const key = await db.apiKey.findUniqueOrThrow({ where: { id: partnerA.apiKey.id } });
  assert.notEqual(key.keyHash, partnerA.rawKey); assert.equal(key.keyHash.length, 64);
});
test("missing/invalid admin and partner credentials fail closed", async () => {
  assert.equal((await api().get("/v1/admin/usage")).status, 401);
  assert.equal((await api().get("/v1/admin/usage").set("Cookie", `${COOKIE}=wrong`)).status, 401);
  assert.equal((await api().get("/admin/usage").set("x-admin-key", "anything")).status, 404, "the shared admin key routes are gone");
  assert.equal((await api().get("/v1/usage")).status, 401);
  assert.equal((await api().get("/v1/usage").set("x-api-key", "wrong")).status, 401);
  const before = sent();
  assert.equal((await api().post("/applications").send({})).status, 403);
  assert.equal(sent(), before);
});
test("scope and payload failures never dispatch or bill", async () => {
  const issued = await issueKey(partnerA, { scopes: ["packages:read"] });
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
test("a lookup whose name does not match the worker goes to review, not VERIFIED", async () => {
  setMode("success");
  const created = await createCase(partnerA, packageCode, "Someone Else"), done = await awaitCase(created.id);
  assert.equal(done.status, "MANUAL_REVIEW"); assert.equal(done.verifications[0].status, "MANUAL_REVIEW");
  assert.equal(done.verificationCard, null);
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
  for (const query of [{ from: "junk", to: "2027-01-01" }, { from: "2026-02-30", to: "2027-01-01" }, { from: "2026-11-01", to: "2026-01-01" }]) assert.equal((await as(keystone, "get", "/v1/admin/usage").query(query)).status, 400);
  const when = new Date("2026-05-01T00:00:00Z"), id = `boundary_${tag}`;
  await db.providerCall.create({ data: { id, tenantId: partnerB.tenant.id, clientId: partnerB.client.id, operationKey: id, provider: "fake", operation: "/boundary", state: "SUCCESS", httpStatus: 200, completedAt: when, startedAt: when } });
  const excluded = await api().get("/v1/usage").set("x-api-key", partnerB.rawKey).query({ from: "2026-04-01", to: "2026-05-01" }); assert.equal(excluded.body.totalSuccessfulApiCalls, 0);
  const included = await api().get("/v1/usage").set("x-api-key", partnerB.rawKey).query({ from: "2026-05-01", to: "2026-05-02" }); assert.equal(included.body.totalSuccessfulApiCalls, 1);
});
test("concurrent key rotation leaves one replacement; old key immediately fails", async () => {
  const issued = await issueKey(partnerA, { scopes: ["usage:read"], expiresInDays: 30 });
  const results = await Promise.all(Array.from({ length: 4 }, () => rotateKey(issued.body.apiKey.id)));
  assert.equal(results.filter(r => r.status === 200).length, 1); assert.equal(results.filter(r => r.status === 409).length, 3);
  assert.equal((await api().get("/v1/usage").set("x-api-key", issued.body.rawKey)).status, 401);
  const replacement = results.find(r => r.status === 200)!.body;
  assert.equal((await api().get("/v1/usage").set("x-api-key", replacement.rawKey)).status, 200);
  assert.deepEqual(replacement.apiKey.scopes, ["usage:read"]); assert.equal(replacement.apiKey.expiresAt, issued.body.apiKey.expiresAt);
});
test("revocation is idempotent, audited once, and rejects further rotation", async () => {
  const issued = await issueKey(partnerA, { scopes: ["usage:read"] });
  for (let n = 0; n < 2; n++) assert.equal((await revokeKey(issued.body.apiKey.id)).status, 200);
  assert.equal(await db.auditLog.count({ where: { action: "apiKey.revoke", apiKeyId: issued.body.apiKey.id } }), 1);
  assert.equal((await api().get("/v1/usage").set("x-api-key", issued.body.rawKey)).status, 401);
  assert.equal((await rotateKey(issued.body.apiKey.id)).status, 409);
});
test("invalid scope/expiry input is rejected before any key is created", async () => {
  const before = await db.apiKey.count({ where: { clientId: partnerA.client.id } });
  for (const body of [{ scopes: [] }, { scopes: "usage:read" }, { scopes: [123] }, { scopes: ["*"] }, { scopes: ["usage:read"], expiresInDays: 0 }, { scopes: ["usage:read"], expiresInDays: 1.5 }, { scopes: ["usage:read"], expiresInDays: 1000000 }]) assert.equal((await issueKey(partnerA, body)).status, 400, JSON.stringify(body));
  assert.equal(await db.apiKey.count({ where: { clientId: partnerA.client.id } }), before);
});
test("audit failure rolls back key rotation, preserving the old credential", async () => {
  const issued = await issueKey(partnerA, { scopes: ["usage:read"] });
  // Dedicated test DB fault injection, targeted to this unique test client only.
  const client = partnerA.client.id; assert.match(client, /^client_[a-f0-9-]+$/);
  await db.$executeRawUnsafe(`CREATE FUNCTION test_fail_rotation_${tag}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."action" = 'apiKey.rotate' AND NEW."clientId" = '${client}' THEN RAISE EXCEPTION 'test audit failure'; END IF; RETURN NEW; END $$`);
  await db.$executeRawUnsafe(`CREATE TRIGGER test_fail_rotation_${tag} BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION test_fail_rotation_${tag}()`);
  const before = await db.apiKey.count({ where: { clientId: client } });
  try {
    assert.equal((await rotateKey(issued.body.apiKey.id)).status, 500);
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
  // A field agent of one vendor, on an ordinary staff session (no password login).
  const vendor = await db.vendor.create({ data: { id: `vendor_${tag}`, slug: `vendor-${tag}`, name: "Test Field Vendor" } });
  const agent = await db.portalUser.create({ data: { id: `agent_${tag}`, email: `agent_${tag}@example.test`, displayName: "Test Agent" } });
  await db.staffRoleBinding.create({ data: { id: `binding_agent_${tag}`, userId: agent.id, roleKey: "FIELD_AGENT", scopeType: "VENDOR", scopeKey: `vendor:${vendor.id}`, vendorId: vendor.id } });
  const agentSession = await staffSession(agent.id);
  // Keystone sees every task and hands A's visit to the vendor; B's stays with no vendor.
  const all = await as(keystone, "get", "/v1/admin/field-tasks"); assert.equal(all.status, 200, JSON.stringify(all.body));
  const taskA = await db.fieldTask.findFirstOrThrow({ where: { applicationId: a.id } });
  const taskB = await db.fieldTask.findFirstOrThrow({ where: { applicationId: b.id } });
  assert.equal((await as(agentSession, "get", "/v1/admin/field-tasks/mine")).body.available.length, 0, "no vendor yet: no agent sees it");
  assert.equal((await as(agentSession, "post", `/v1/admin/field-tasks/${taskA.id}/vendor`).send({ vendorId: vendor.id })).status, 403, "agents cannot hand out tasks");
  assert.equal((await as(keystone, "post", `/v1/admin/field-tasks/${taskA.id}/vendor`).send({ vendorId: vendor.id })).status, 200);
  const list = await as(agentSession, "get", "/v1/admin/field-tasks/mine"); assert.equal(list.status, 200);
  assert.deepEqual(list.body.available.map((item: { id: string }) => item.id), [taskA.id]);
  assert.equal((await as(agentSession, "get", `/v1/admin/field-tasks/${taskB.id}`)).status, 404, "another partner's visit stays hidden");
  const task = list.body.available[0];
  const before = (await usage()).totalSuccessfulApiCalls;
  assert.equal((await as(agentSession, "post", `/v1/admin/field-tasks/${task.id}/accept`)).status, 200);
  assert.equal((await as(keystone, "post", `/v1/admin/field-tasks/${task.id}/vendor`).send({ vendorId: null })).status, 409, "an accepted task keeps its vendor");
  assert.equal((await as(agentSession, "post", `/v1/admin/field-tasks/${task.id}/submit`).send({ outcome: "PERSON_MET", notes: "Evidence for QA" })).status, 200);
  const pending = await db.application.findUniqueOrThrow({ where: { id: a.id }, include: { verificationCard: true, verifications: true } });
  assert.equal(pending.status, "MANUAL_REVIEW"); assert.equal(pending.verificationCard, null);
  assert.equal((await usage()).totalSuccessfulApiCalls, before);
  const decision = await api().post(`/v1/verifications/${pending.verifications[0].id}/decision`).set("x-api-key", partnerA.rawKey).send({ decision: "VERIFIED", note: "QA approved evidence" });
  assert.equal(decision.status, 201); assert.equal(decision.body.status, "VERIFIED"); assert.equal(decision.body.card.status, "ACTIVE");
  assert.equal((await usage()).totalSuccessfulApiCalls, before);
  assert.equal((await as(agentSession, "post", `/v1/admin/field-tasks/${task.id}/accept`)).status, 400);
});
test("disabled organizations cannot use keys, issue new keys or be silently reactivated", async () => {
  await db.client.update({ where: { id: partnerB.client.id }, data: { status: "INACTIVE" } });
  assert.equal((await api().get("/v1/usage").set("x-api-key", partnerB.rawKey)).status, 401);
  assert.equal((await issueKey(partnerB, { scopes: ["usage:read"] })).status, 403);
  await assert.rejects(new PartnerProvisioning(db).createPartner({ tenantSlug: partnerB.tenant.slug, tenantName: "Changed", clientCode: partnerB.client.code, clientName: "Changed" }));
  assert.equal((await db.client.findUniqueOrThrow({ where: { id: partnerB.client.id } })).status, "INACTIVE");
});
