import "reflect-metadata";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { join, resolve } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
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
import { issueWorkerToken } from "../../apps/verification-api/src/common/auth/worker-token";
import { DEFAULT_ENABLED_PRODUCTS } from "../../apps/verification-api/src/integrations/surepass/products";
import { AadhaarMasker } from "../../apps/verification-api/src/modules/document-storage/aadhaar-masker";
import { WebhookDispatcher } from "../../apps/verification-api/src/modules/webhooks/webhook-dispatcher.service";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { createHmac } from "node:crypto";

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
function ok<T extends { status: number; body: unknown }>(response: T, status = 200): T {
  assert.equal(response.status, status, JSON.stringify(response.body));
  return response;
}
function as(staff: Staff, method: "get" | "post" | "put" | "delete", path: string) {
  let call = api()[method](path).set("Cookie", `${COOKIE}=${staff.token}`).set("Origin", ORIGIN);
  if (method !== "get") call = call.set("x-csrf-token", staff.csrf);
  return call;
}
// Smallest files that pass the image checks: a JPEG photo and a PNG signature.
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const AT_HOME = { latitude: "12.97", longitude: "77.59" };
function addEvidence(staff: Staff, taskId: string, kind: string, fields: Record<string, string> = kind === "PHOTO" ? AT_HOME : {}, file = kind === "SIGNATURE" ? PNG : JPEG, contentType = kind === "SIGNATURE" ? "image/png" : "image/jpeg") {
  let call = as(staff, "post", `/v1/admin/field-tasks/${taskId}/evidence`).field("kind", kind);
  for (const [key, value] of Object.entries(fields)) call = call.field(key, value);
  return call.attach("file", file, { filename: kind === "SIGNATURE" ? "signature.png" : "house.jpg", contentType });
}
/** What a visit needs before it is submitted: a photo, and a signature when someone was met. */
async function evidenceFor(staff: Staff, taskId: string, outcome: string) {
  ok(await addEvidence(staff, taskId, "PHOTO"), 201);
  if (outcome === "PERSON_MET" || outcome === "FAMILY_MET") ok(await addEvidence(staff, taskId, "SIGNATURE"), 201);
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
  process.env.FIELD_EVIDENCE_LOCAL_DIR = mkdtempSync(join(tmpdir(), "field-evidence-"));
  process.env.WEBHOOK_JOBS = "off"; process.env.WEBHOOK_INSECURE_HOSTS = "127.0.0.1"; process.env.WEBHOOK_SECRET_KEY = randomBytes(32).toString("base64");
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
  await evidenceFor(agentSession, task.id, "PERSON_MET");
  assert.equal((await as(agentSession, "post", `/v1/admin/field-tasks/${task.id}/submit`).send({ outcome: "PERSON_MET", notes: "Evidence for QA" })).status, 200);
  const pending = await db.application.findUniqueOrThrow({ where: { id: a.id }, include: { verificationCard: true, verifications: true } });
  assert.equal(pending.status, "MANUAL_REVIEW"); assert.equal(pending.verificationCard, null);
  assert.equal((await usage()).totalSuccessfulApiCalls, before);
  const decision = await api().post(`/v1/verifications/${pending.verifications[0].id}/decision`).set("x-api-key", partnerA.rawKey).send({ decision: "VERIFIED", note: "QA approved evidence" });
  assert.equal(decision.status, 201); assert.equal(decision.body.status, "VERIFIED"); assert.equal(decision.body.card.status, "ACTIVE");
  assert.equal((await usage()).totalSuccessfulApiCalls, before);
  assert.equal((await as(agentSession, "post", `/v1/admin/field-tasks/${task.id}/accept`)).status, 400);
});
test("review queue and send-back: Keystone returns a field visit, the agent visits again, then it is decided", async () => {
  const code = `TEST_SENDBACK_${tag}`.toUpperCase();
  await db.verificationPackage.create({ data: { id: `pkg_sendback_${tag}`, code, version: 1, name: "Test send-back", checks: [{ type: "CURRENT_ADDRESS", mode: "REQUIRED", execution: "MANUAL" }] } });
  const created = await createCase(partnerA, code, "Asha Verma");
  const vendor = await db.vendor.create({ data: { id: `vendor_sb_${tag}`, slug: `vendor-sb-${tag}`, name: "Send-back Vendor" } });
  const agent = await db.portalUser.create({ data: { id: `agent_sb_${tag}`, email: `agent_sb_${tag}@example.test`, displayName: "Send-back Agent" } });
  await db.staffRoleBinding.create({ data: { id: `binding_agent_sb_${tag}`, userId: agent.id, roleKey: "FIELD_AGENT", scopeType: "VENDOR", scopeKey: `vendor:${vendor.id}`, vendorId: vendor.id } });
  const agentSession = await staffSession(agent.id);
  assert.equal((await as(keystone, "get", "/v1/admin/field-tasks")).status, 200);
  const task = await db.fieldTask.findFirstOrThrow({ where: { applicationId: created.id } });
  const check = await db.verification.findUniqueOrThrow({ where: { id: task.verificationId } });
  const inQueue = async (ready: boolean) => (await as(keystone, "get", `/v1/admin/review-queue?ready=${ready}`)).body.items.find((item: { checkId: string }) => item.checkId === check.id);

  // Waiting for the visit: listed only when asking for everything, and not ready to decide.
  assert.equal(await inQueue(true), undefined, "not ready before the visit");
  const waiting = await inQueue(false);
  assert.equal(waiting.ready, false); assert.equal(waiting.reason, "Waiting for the field visit"); assert.equal(waiting.worker.name, "Asha Verma");
  assert.equal((await as(agentSession, "get", "/v1/admin/review-queue")).status, 403, "the queue is Keystone's");

  ok(await as(keystone, "post", `/v1/admin/field-tasks/${task.id}/vendor`).send({ vendorId: vendor.id }));
  ok(await as(agentSession, "post", `/v1/admin/field-tasks/${task.id}/accept`));
  ok(await as(agentSession, "post", `/v1/admin/field-tasks/${task.id}/arrive`).send({ latitude: 12.97, longitude: 77.59 }));
  await evidenceFor(agentSession, task.id, "NEIGHBOUR_CONFIRMED");
  ok(await as(agentSession, "post", `/v1/admin/field-tasks/${task.id}/submit`).send({ outcome: "NEIGHBOUR_CONFIRMED", notes: "Neighbour confirmed, house locked" }));
  const submitted = await inQueue(true);
  assert.equal(submitted.ready, true); assert.equal(submitted.reason, "Field visit submitted"); assert.equal(submitted.fieldVisit.vendor.name, "Send-back Vendor");

  // Send it back: only Keystone, only with a note, only once submitted.
  assert.equal((await as(agentSession, "post", `/v1/admin/field-tasks/${task.id}/send-back`).send({ note: "Meet the person themselves" })).status, 403);
  assert.equal((await as(keystone, "post", `/v1/admin/field-tasks/${task.id}/send-back`).send({ note: "no" })).status, 400);
  const returned = ok(await as(keystone, "post", `/v1/admin/field-tasks/${task.id}/send-back`).send({ note: "Meet the person themselves, not a neighbour" })).body;
  assert.equal(returned.status, "ACCEPTED", "back with the same agent");
  assert.equal(returned.return_count, 1);
  assert.equal(returned.arrived_at, null, "the next visit records its own arrival");
  assert.equal(returned.previous_attempts[0].outcome, "NEIGHBOUR_CONFIRMED");
  assert.equal((await as(keystone, "post", `/v1/admin/field-tasks/${task.id}/send-back`).send({ note: "Again please" })).status, 409, "nothing submitted to send back");
  const agentView = ok(await as(agentSession, "get", `/v1/admin/field-tasks/${task.id}`)).body;
  assert.equal(agentView.review_note, "Meet the person themselves, not a neighbour");
  assert.ok((ok(await as(agentSession, "get", "/v1/admin/field-tasks/mine")).body.open as Array<{ id: string }>).some((item) => item.id === task.id), "in the agent's open list");
  assert.equal(await inQueue(true), undefined, "not ready while the next visit is pending");
  assert.equal((await inQueue(false)).reason, "Sent back; waiting for the next visit");

  // The second visit makes it ready again, then Keystone decides.
  ok(await as(agentSession, "post", `/v1/admin/field-tasks/${task.id}/arrive`).send({ latitude: 12.97, longitude: 77.59 }));
  await evidenceFor(agentSession, task.id, "PERSON_MET");
  ok(await as(agentSession, "post", `/v1/admin/field-tasks/${task.id}/submit`).send({ outcome: "PERSON_MET", notes: "Met Asha at home" }));
  const again = await inQueue(true);
  assert.equal(again.reason, "Field visit submitted again"); assert.equal(again.fieldVisit.timesSentBack, 1);
  const decided = ok(await as(keystone, "post", `/v1/admin/cases/${created.id}/checks/${check.id}/decision`).send({ decision: "VERIFIED", note: "Met in person" })).body;
  assert.equal(decided.decision, "VERIFIED");
  assert.equal(await inQueue(false), undefined, "decided checks leave the queue");
});
test("field-task assignment: Keystone assigns, reassigns, sets due dates and cancels; vendor admins assign their own agents", async () => {
  const code = `TEST_ASSIGN_${tag}`.toUpperCase();
  await db.verificationPackage.create({ data: { id: `pkg_assign_${tag}`, code, version: 1, name: "Test assignment", checks: [{ type: "CURRENT_ADDRESS", mode: "REQUIRED", execution: "MANUAL" }] } });
  const first = await createCase(partnerA, code, "Ravi Kumar"), second = await createCase(partnerA, code, "Meena Das");
  const vendorX = await db.vendor.create({ data: { id: `vendor_x_${tag}`, slug: `vendor-x-${tag}`, name: "Vendor X" } });
  const vendorY = await db.vendor.create({ data: { id: `vendor_y_${tag}`, slug: `vendor-y-${tag}`, name: "Vendor Y" } });
  const person = async (key: string, roleKey: string, vendorId: string) => {
    const user = await db.portalUser.create({ data: { id: `${key}_${tag}`, email: `${key}_${tag}@example.test`, displayName: key } });
    await db.staffRoleBinding.create({ data: { id: `binding_${key}_${tag}`, userId: user.id, roleKey, scopeType: "VENDOR", scopeKey: `vendor:${vendorId}`, vendorId } });
    return { id: user.id, session: await staffSession(user.id) };
  };
  const agentX1 = await person("agent_x1", "FIELD_AGENT", vendorX.id), agentX2 = await person("agent_x2", "FIELD_AGENT", vendorX.id);
  const adminX = await person("admin_x", "VENDOR_ADMIN", vendorX.id), agentY = await person("agent_y", "FIELD_AGENT", vendorY.id);
  ok(await as(keystone, "get", "/v1/admin/field-tasks"));
  const taskOf = (caseId: string) => db.fieldTask.findFirstOrThrow({ where: { applicationId: caseId } });
  const one = await taskOf(first.id), two = await taskOf(second.id);
  const days = (one.dueAt!.getTime() - Date.now()) / 86_400_000;
  assert.ok(days > 2.9 && days <= 3, `a new visit is due in 3 days (${days})`);
  const assign = (staff: Staff, taskId: string, body: Record<string, unknown>) => as(staff, "post", `/v1/admin/field-tasks/${taskId}/assign`).send(body);
  const ids = (items: Array<{ id: string }>) => items.map((item) => item.id);

  // Keystone gives the first visit to an agent at Vendor X, with a due date.
  const due = new Date(Date.now() + 2 * 86_400_000).toISOString();
  assert.equal((await assign(agentX1.session, one.id, { vendorId: vendorX.id })).status, 403, "agents cannot assign");
  assert.equal((await assign(keystone, one.id, { vendorId: vendorX.id, dueAt: new Date(Date.now() - 60_000).toISOString() })).status, 400, "due dates are in the future");
  assert.equal((await assign(keystone, two.id, { vendorId: vendorY.id, agentId: agentX1.id })).status, 400, "the agent must work for that vendor");
  const given = ok(await assign(keystone, one.id, { vendorId: vendorX.id, agentId: agentX1.id, dueAt: due })).body;
  assert.equal(given.status, "ASSIGNED"); assert.equal(given.agent.id, agentX1.id); assert.equal(given.vendor.id, vendorX.id); assert.equal(given.due_at, due);
  assert.ok(ids(ok(await as(agentX1.session, "get", "/v1/admin/field-tasks/mine")).body.open).includes(one.id));
  assert.equal((await as(agentX2.session, "get", `/v1/admin/field-tasks/${one.id}`)).status, 404, "another agent cannot see it");
  ok(await as(agentX1.session, "post", `/v1/admin/field-tasks/${one.id}/accept`));
  ok(await as(agentX1.session, "post", `/v1/admin/field-tasks/${one.id}/arrive`).send({ latitude: 12.97, longitude: 77.59 }));

  // Vendor X's admin moves it to their other agent, who starts over; they cannot change the vendor or reach other vendors' tasks.
  assert.equal((await assign(adminX.session, one.id, { vendorId: vendorY.id })).status, 403);
  assert.equal((await assign(adminX.session, two.id, { agentId: agentX2.id })).status, 404);
  const moved = ok(await assign(adminX.session, one.id, { agentId: agentX2.id })).body;
  assert.equal(moved.status, "ASSIGNED"); assert.equal(moved.agent.id, agentX2.id); assert.equal(moved.arrived_at, null); assert.equal(moved.due_at, due, "the due date stays");
  assert.equal((await as(agentX1.session, "get", `/v1/admin/field-tasks/${one.id}`)).status, 404, "the earlier agent loses it");
  assert.ok(ids(ok(await as(agentX2.session, "get", "/v1/admin/field-tasks/mine")).body.open).includes(one.id));
  assert.ok(!ids(ok(await as(adminX.session, "get", "/v1/admin/field-tasks")).body.items).includes(two.id), "a vendor admin sees only their vendor's tasks");

  // Keystone moves it to Vendor Y: no agent yet, so it waits in Vendor Y's pool.
  const toY = ok(await assign(keystone, one.id, { vendorId: vendorY.id })).body;
  assert.equal(toY.status, "PENDING_ASSIGNMENT"); assert.equal(toY.agent, null);
  assert.ok(ids(ok(await as(agentY.session, "get", "/v1/admin/field-tasks/mine")).body.available).includes(one.id));

  // Overdue: open past its due date.
  await db.fieldTask.update({ where: { id: two.id }, data: { dueAt: new Date(Date.now() - 3_600_000) } });
  const overdue = ok(await as(keystone, "get", "/v1/admin/field-tasks?view=overdue")).body;
  assert.ok(ids(overdue.items).includes(two.id)); assert.ok(!ids(overdue.items).includes(one.id));
  assert.equal(overdue.items.find((item: { id: string }) => item.id === two.id).overdue, true);
  assert.ok(overdue.counts.overdue >= 1 && overdue.counts.open >= 2 && overdue.counts.noVendor >= 1);
  assert.equal((await as(keystone, "get", "/v1/admin/field-tasks?view=late")).status, 400);

  // Keystone cancels the second visit: it leaves the open views and the check is ready to decide without it.
  assert.equal((await as(adminX.session, "post", `/v1/admin/field-tasks/${two.id}/cancel`).send({ reason: "Not needed" })).status, 403);
  assert.equal((await as(keystone, "post", `/v1/admin/field-tasks/${two.id}/cancel`).send({ reason: "no" })).status, 400);
  const cancelled = ok(await as(keystone, "post", `/v1/admin/field-tasks/${two.id}/cancel`).send({ reason: "Address confirmed by the partner" })).body;
  assert.equal(cancelled.status, "CANCELLED"); assert.equal(cancelled.cancel_reason, "Address confirmed by the partner"); assert.equal(cancelled.overdue, false);
  assert.equal((await as(keystone, "post", `/v1/admin/field-tasks/${two.id}/cancel`).send({ reason: "Again" })).status, 409);
  assert.ok(ids(ok(await as(keystone, "get", "/v1/admin/field-tasks?view=cancelled")).body.items).includes(two.id));
  const queued = ok(await as(keystone, "get", "/v1/admin/review-queue")).body.items.find((item: { checkId: string }) => item.checkId === two.verificationId);
  assert.equal(queued.reason, "Field visit cancelled: Address confirmed by the partner"); assert.equal(queued.ready, true);

  // Keystone can bring it back; a submitted visit can be neither moved nor cancelled.
  const reopened = ok(await assign(keystone, two.id, { vendorId: vendorX.id, agentId: agentX1.id })).body;
  assert.equal(reopened.status, "ASSIGNED"); assert.equal(reopened.cancel_reason, null);
  ok(await as(agentX1.session, "post", `/v1/admin/field-tasks/${two.id}/accept`));
  await evidenceFor(agentX1.session, two.id, "PERSON_MET");
  ok(await as(agentX1.session, "post", `/v1/admin/field-tasks/${two.id}/submit`).send({ outcome: "PERSON_MET", notes: "Met at home" }));
  assert.equal((await assign(keystone, two.id, { agentId: agentX2.id })).status, 409);
  assert.equal((await as(keystone, "post", `/v1/admin/field-tasks/${two.id}/cancel`).send({ reason: "Too late" })).status, 409);
  assert.ok(ids(ok(await as(keystone, "get", "/v1/admin/field-tasks?view=completed")).body.items).includes(two.id));

  // Deciding a check while its visit is still open closes the visit.
  ok(await as(keystone, "post", `/v1/admin/cases/${first.id}/checks/${one.verificationId}/decision`).send({ decision: "VERIFIED", note: "Confirmed by phone" }));
  const closed = await taskOf(first.id);
  assert.equal(closed.status, "CANCELLED"); assert.equal(closed.cancelReason, "The check was decided without this visit");
  assert.ok(!ids(ok(await as(agentY.session, "get", "/v1/admin/field-tasks/mine")).body.available).includes(one.id));
});
test("field evidence: photos with GPS and a signature, required to submit, seen by Keystone and the vendor admin only", async () => {
  const code = `TEST_EVIDENCE_${tag}`.toUpperCase();
  await db.verificationPackage.create({ data: { id: `pkg_evidence_${tag}`, code, version: 1, name: "Test evidence", checks: [{ type: "CURRENT_ADDRESS", mode: "REQUIRED", execution: "MANUAL" }] } });
  const created = await createCase(partnerA, code, "Kiran Rao");
  const vendor = await db.vendor.create({ data: { id: `vendor_ev_${tag}`, slug: `vendor-ev-${tag}`, name: "Evidence Vendor" } });
  const other = await db.vendor.create({ data: { id: `vendor_ev2_${tag}`, slug: `vendor-ev2-${tag}`, name: "Other Vendor" } });
  const person = async (key: string, roleKey: string, vendorId: string) => {
    const user = await db.portalUser.create({ data: { id: `${key}_${tag}`, email: `${key}_${tag}@example.test`, displayName: key } });
    await db.staffRoleBinding.create({ data: { id: `binding_${key}_${tag}`, userId: user.id, roleKey, scopeType: "VENDOR", scopeKey: `vendor:${vendorId}`, vendorId } });
    return { id: user.id, session: await staffSession(user.id) };
  };
  const agent = await person("ev_agent", "FIELD_AGENT", vendor.id), colleague = await person("ev_colleague", "FIELD_AGENT", vendor.id);
  const vendorAdmin = await person("ev_admin", "VENDOR_ADMIN", vendor.id), outsider = await person("ev_outsider", "FIELD_AGENT", other.id);
  ok(await as(keystone, "get", "/v1/admin/field-tasks"));
  const task = await db.fieldTask.findFirstOrThrow({ where: { applicationId: created.id } });
  ok(await as(keystone, "post", `/v1/admin/field-tasks/${task.id}/assign`).send({ vendorId: vendor.id, agentId: agent.id }));
  const submit = (outcome: string) => as(agent.session, "post", `/v1/admin/field-tasks/${task.id}/submit`).send({ outcome });
  const evidence = (staff: Staff) => as(staff, "get", `/v1/admin/field-tasks/${task.id}/evidence`);

  // Only on an open visit, only images, and photos carry their GPS location.
  assert.equal((await addEvidence(agent.session, task.id, "PHOTO")).status, 400, "accept first");
  ok(await as(agent.session, "post", `/v1/admin/field-tasks/${task.id}/accept`));
  assert.equal((await addEvidence(agent.session, task.id, "VIDEO")).status, 400);
  assert.equal((await addEvidence(agent.session, task.id, "PHOTO", AT_HOME, Buffer.from("not an image"), "text/plain")).status, 400);
  assert.equal((await addEvidence(agent.session, task.id, "PHOTO", AT_HOME, PNG, "image/jpeg")).status, 400, "bytes must match the type");
  assert.equal((await addEvidence(agent.session, task.id, "PHOTO", {})).status, 400, "a photo needs GPS");
  assert.equal((await addEvidence(agent.session, task.id, "PHOTO", { latitude: "12.97" })).status, 400);
  assert.equal((await addEvidence(agent.session, task.id, "PHOTO", { latitude: "123", longitude: "77.59" })).status, 400);
  assert.equal((await addEvidence(colleague.session, task.id, "PHOTO")).status, 404, "another agent's visit");

  // Submitting needs a photo, and a signature when the person was met.
  assert.match((await submit("PERSON_MET")).body.message, /photo/);
  const photo = ok(await addEvidence(agent.session, task.id, "PHOTO", { ...AT_HOME, capturedAt: new Date(Date.now() - 60_000).toISOString() }), 201).body;
  assert.equal(photo.kind, "PHOTO"); assert.deepEqual(photo.location, { latitude: 12.97, longitude: 77.59 }); assert.equal(photo.current, true);
  assert.match((await submit("PERSON_MET")).body.message, /signature/);
  const signature = ok(await addEvidence(agent.session, task.id, "SIGNATURE"), 201).body;
  assert.equal(signature.location, null);
  const extra = ok(await addEvidence(agent.session, task.id, "PHOTO"), 201).body;
  ok(await as(agent.session, "delete", `/v1/admin/field-tasks/${task.id}/evidence/${extra.id}`));
  assert.equal((await as(agent.session, "delete", `/v1/admin/field-tasks/${task.id}/evidence/${extra.id}`)).status, 404);

  // Who sees it: the agent, their vendor's admin and Keystone; not a colleague or another vendor.
  assert.equal(ok(await as(agent.session, "get", `/v1/admin/field-tasks/${task.id}`)).body.evidence.length, 2);
  assert.deepEqual(ok(await evidence(vendorAdmin.session)).body.items.map((item: { id: string }) => item.id), [photo.id, signature.id]);
  assert.equal(ok(await evidence(keystone)).body.items.length, 2);
  assert.equal((await evidence(colleague.session)).status, 404);
  assert.equal((await evidence(outsider.session)).status, 404);
  const file = ok(await as(keystone, "get", photo.file_url).buffer(true));
  assert.equal(file.headers["content-type"], "image/jpeg"); assert.ok(Buffer.compare(file.body as Buffer, JPEG) === 0);
  assert.equal((await as(outsider.session, "get", photo.file_url)).status, 404);

  // The submission records its evidence; nothing more can be added once it is in.
  ok(await submit("PERSON_MET"));
  const result = (await db.verification.findUniqueOrThrow({ where: { id: task.verificationId } })).result as { evidence: Array<{ id: string }> };
  assert.deepEqual(result.evidence.map((item) => item.id), [photo.id, signature.id]);
  assert.equal((await addEvidence(agent.session, task.id, "PHOTO")).status, 400);
  const queued = ok(await as(keystone, "get", "/v1/admin/review-queue")).body.items.find((item: { checkId: string }) => item.checkId === task.verificationId);
  assert.equal(queued.fieldVisit.evidenceCount, 2);

  // Sent back, the next visit needs its own photo; the earlier ones stay, marked as an earlier attempt.
  const returned = ok(await as(keystone, "post", `/v1/admin/field-tasks/${task.id}/send-back`).send({ note: "Photograph the nameplate" })).body;
  assert.deepEqual(returned.previous_attempts[0].evidenceIds, [photo.id, signature.id]);
  assert.ok(ok(await evidence(agent.session)).body.items.every((item: { current: boolean }) => !item.current));
  assert.match((await submit("ADDRESS_EXISTS")).body.message, /photo/);
  ok(await addEvidence(agent.session, task.id, "PHOTO"), 201);
  ok(await submit("ADDRESS_EXISTS"));
});
test("document photos: a chosen check's card is read to pre-fill its details, nothing is stored, and each read is on the ledger", async () => {
  const workerApp = await new PartnerProvisioning(db).createPartner({ tenantSlug: `ocr-app-${tag.toLowerCase()}`, tenantName: "OCR app", clientCode: "WORKER_PORTAL", clientName: "OCR worker app", scopes: ["worker:cases"] });
  const token = issueWorkerToken({ tenantId: workerApp.tenant.id, clientId: workerApp.client.id, phone: `9198${String(Date.now()).slice(-8)}` }).token;
  const worker = (method: "get" | "post" | "put", path: string) => api()[method](`/v1/worker/case${path}`).set("x-api-key", workerApp.rawKey).set("x-worker-token", token);
  const read = (kind: string, photos: Array<[string, Buffer, string]>) => photos.reduce((call, [field, bytes, type]) => call.attach(field, bytes, { filename: `${field}.jpg`, contentType: type }), worker("post", `/checks/${kind}/read`));
  const front: [string, Buffer, string] = ["front", JPEG, "image/jpeg"], back: [string, Buffer, string] = ["back", JPEG, "image/jpeg"];
  const previous = process.env.SUREPASS_ENABLED_PRODUCTS;
  process.env.SUREPASS_ENABLED_PRODUCTS = [...DEFAULT_ENABLED_PRODUCTS, "ocr-pan", "ocr-license"].join(",");
  try {
    const opened = ok(await worker("get", "")).body;
    ok(await worker("put", "/name").send({ fullName: "Test Worker" }));
    const chosen = ok(await worker("put", "/checks").send({ checks: ["PAN", "DRIVING_LICENSE"] })).body;
    const readable = Object.fromEntries(chosen.catalog.map((item: { check: string; readable: boolean }) => [item.check, item.readable]));
    assert.equal(readable.PAN, true); assert.equal(readable.DRIVING_LICENSE, true); assert.equal(readable.PASSPORT, false, "passport OCR is not enabled here");
    assert.equal((await read("PAN", [front])).status, 400, "consent first");
    await db.prepaidCase.create({ data: { applicationId: opened.applicationId, tenantId: workerApp.tenant.id, source: "ORDER", packageCode: "TEST", packageVersion: 1, coveredChecks: ["AADHAAR", "PAN", "DRIVING_LICENSE"] } });
    ok(await worker("post", "/consent").send({ textVersion: "test-1", items: ["case", "identity"] }));

    // Only images or PDFs that are what they say; the licence needs both sides.
    assert.equal((await read("VOTER_ID", [front])).status, 400, "no photo reading for this check");
    assert.equal((await read("PASSPORT", [front])).status, 503);
    assert.equal((await read("PAN", [])).status, 400);
    assert.equal((await read("PAN", [["front", Buffer.from("not an image"), "image/jpeg"]])).status, 400);
    assert.equal((await read("DRIVING_LICENSE", [front])).status, 400);

    const before = await db.providerCall.count({ where: { applicationId: opened.applicationId } });
    const pan = ok(await read("PAN", [front])).body;
    assert.deepEqual(pan.fields, { panNumber: "ABCPD1234E" });
    assert.deepEqual(pan.details, { name: "Test Worker", fatherName: "Suresh Kumar", dateOfBirth: "1994-08-15" });
    assert.equal(pan.nameMatchesAadhaar, true);
    const licence = ok(await read("DRIVING_LICENSE", [front, back])).body;
    assert.deepEqual(licence.fields, { licenceNumber: "KA0120190001234", dateOfBirth: "1994-08-15" });
    assert.deepEqual(licence.lowConfidence, ["dateOfBirth"]);
    const calls = await db.providerCall.findMany({ where: { applicationId: opened.applicationId }, select: { operation: true, state: true } });
    assert.equal(calls.length, before + 2); assert.ok(calls.every((call) => call.state === "SUCCESS"));
    assert.equal(await db.applicationDocument.count({ where: { applicationId: opened.applicationId } }), 0, "the photos are not kept");

    // Once the check has run its card is not read again.
    await db.verification.updateMany({ where: { applicationId: opened.applicationId, type: "PAN" }, data: { status: "VERIFIED" } });
    assert.equal((await read("PAN", [front])).status, 409, "a check already done is not read again");

    // With the product switched off the app is told to type instead.
    process.env.SUREPASS_ENABLED_PRODUCTS = DEFAULT_ENABLED_PRODUCTS.join(",");
    assert.equal((await read("DRIVING_LICENSE", [front, back])).status, 503);
    assert.equal(ok(await worker("get", "")).body.catalog.find((item: { check: string }) => item.check === "DRIVING_LICENSE").readable, false);
  } finally {
    if (previous === undefined) delete process.env.SUREPASS_ENABLED_PRODUCTS; else process.env.SUREPASS_ENABLED_PRODUCTS = previous;
  }
});
test("Aadhaar masking goes through Surepass on the case's ledger and returns the masked image", async () => {
  const created = await createCase(partnerA);
  const previous = { products: process.env.SUREPASS_ENABLED_PRODUCTS, hosts: process.env.SUREPASS_MASKED_IMAGE_HOSTS };
  process.env.SUREPASS_ENABLED_PRODUCTS = [...DEFAULT_ENABLED_PRODUCTS, "ocr-aadhaar-masking"].join(",");
  process.env.SUREPASS_MASKED_IMAGE_HOSTS = "127.0.0.1";
  try {
    const masker = app.get(AadhaarMasker);
    const masked = await masker.mask({ buffer: JPEG, originalname: "aadhaar.jpg", mimetype: "image/jpeg" }, { tenantId: partnerA.tenant.id, clientId: partnerA.client.id, applicationId: created.id, documentId: `doc_mask_${tag}` });
    assert.equal(masked.contentType, "image/jpeg"); assert.ok(masked.bytes.length > 0);
    const call = await db.providerCall.findFirstOrThrow({ where: { operationKey: { startsWith: `aadhaar_mask_doc_mask_${tag}` } } });
    assert.equal(call.applicationId, created.id); assert.equal(call.state, "SUCCESS");
    process.env.SUREPASS_MASKED_IMAGE_HOSTS = "amazonaws.com";
    await assert.rejects(masker.mask({ buffer: JPEG, originalname: "aadhaar.jpg", mimetype: "image/jpeg" }, { tenantId: partnerA.tenant.id, clientId: partnerA.client.id, applicationId: created.id, documentId: `doc_mask2_${tag}` }), { status: 503 }, "only Surepass's own hosts");
  } finally {
    for (const [key, value] of [["SUREPASS_ENABLED_PRODUCTS", previous.products], ["SUREPASS_MASKED_IMAGE_HOSTS", previous.hosts]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
test("modules: a case is for a person, a vehicle or both, shown by module and searchable by vehicle number", async () => {
  const both = `TEST_DRIVER_VEHICLE_${tag}`.toUpperCase(), people = `TEST_PEOPLE_${tag}`.toUpperCase();
  await db.verificationPackage.create({ data: { id: `pkg_both_${tag}`, code: both, version: 1, name: "Driver with vehicle", checks: [{ type: "PAN", mode: "REQUIRED", execution: "MANUAL" }, { type: "RC_V2", mode: "REQUIRED", execution: "MANUAL" }] } });
  await db.verificationPackage.create({ data: { id: `pkg_people_${tag}`, code: people, version: 1, name: "People only", checks: [{ type: "PAN", mode: "REQUIRED", execution: "MANUAL" }] } });
  const vehicleNumber = `KA01${tag.slice(0, 2).toUpperCase().replace(/\d/g, "Z")}${String(Date.now()).slice(-4)}`;
  const withVehicle = await api().post("/v1/applications").set("x-api-key", partnerA.rawKey).send({ packageCode: both, personal: { panNumber: "ABCDE1234F", nameAsAadhaar: "Driver Test", submittedAddress: "Test Address" }, vehicle: { registrationNumber: vehicleNumber }, consent: { granted: true } });
  assert.equal(withVehicle.status, 201, JSON.stringify(withVehicle.body));
  const personOnly = await createCase(partnerA, people);

  // The partner API says which modules a case covers and what it verifies.
  const details = ok(await api().get(`/v1/applications/${withVehicle.body.id}/verifications`).set("x-api-key", partnerA.rawKey)).body;
  assert.deepEqual(details.modules, ["PEOPLE", "VEHICLE"]);
  assert.deepEqual(details.subject, { person: true, vehicle: { registrationNumber: vehicleNumber } });
  assert.deepEqual(Object.fromEntries(details.verifications.map((check: { type: string; module: string }) => [check.type, check.module])), { PAN: "PEOPLE", RC_V2: "VEHICLE" });

  // The admin case: each check's module, and the report's sections by module.
  const detail = ok(await as(keystone, "get", `/v1/admin/cases/${withVehicle.body.id}`)).body;
  assert.deepEqual(detail.subject, { person: true, vehicle: { registrationNumber: vehicleNumber } });
  assert.deepEqual(detail.modules.map((section: { module: string; checkIds: string[] }) => [section.module, section.checkIds.length]), [["PEOPLE", 1], ["VEHICLE", 1]]);
  assert.equal(detail.checks.find((check: { type: string }) => check.type === "RC_V2").module, "VEHICLE");
  const personDetail = ok(await as(keystone, "get", `/v1/admin/cases/${personOnly.id}`)).body;
  assert.deepEqual(personDetail.subject, { person: true, vehicle: null });

  // Lists filter by module and find a case by its vehicle number.
  const ids = async (query: string) => (ok(await as(keystone, "get", `/v1/admin/cases?limit=100&${query}`)).body.items as Array<{ id: string }>).map((item) => item.id);
  const vehicleCases = await ids("module=vehicle");
  assert.ok(vehicleCases.includes(withVehicle.body.id)); assert.ok(!vehicleCases.includes(personOnly.id));
  const peopleCases = await ids("module=PEOPLE");
  assert.ok(peopleCases.includes(withVehicle.body.id) && peopleCases.includes(personOnly.id), "a driver with a vehicle is in both");
  assert.equal((await as(keystone, "get", "/v1/admin/cases?module=BOAT")).status, 400);
  assert.deepEqual(await ids(`search=${vehicleNumber.slice(0, 4)} ${vehicleNumber.slice(4)}`), [withVehicle.body.id]);
  const listed = ok(await as(keystone, "get", `/v1/admin/cases?search=${vehicleNumber}`)).body.items[0];
  assert.deepEqual(listed.modules, ["PEOPLE", "VEHICLE"]); assert.equal(listed.subject.vehicle.registrationNumber, vehicleNumber);

  // A Vehicle package holds only vehicle checks.
  assert.equal((await as(keystone, "post", "/v1/admin/packages").send({ code: `VEH_BAD_${tag}`, name: "Bad vehicle", module: "VEHICLE", listPricePaise: 10_000, checks: [{ type: "RC_V2" }, { type: "PAN" }] })).status, 400);
  const fleet = ok(await as(keystone, "post", "/v1/admin/packages").send({ code: `VEH_${tag}`, name: "Fleet vehicle", module: "VEHICLE", listPricePaise: 10_000, checks: [{ type: "RC_V2" }, { type: "VEHICLE_CHALLAN" }] }), 201).body;
  assert.equal(fleet.module, "VEHICLE");
  assert.equal((await as(keystone, "put", `/v1/admin/packages/${fleet.code}/draft`).send({ checks: [{ type: "PAN" }] })).status, 400);
});
test("final result, JSON report and signed webhooks: a partner hears about each change and reads the report", async () => {
  // A receiver that records what it gets and answers with `reply`.
  const received: Array<{ headers: IncomingHttpHeaders; body: string }> = [];
  let reply = 200;
  const receiver = createServer((req, res) => { let body = ""; req.on("data", (chunk) => (body += chunk)); req.on("end", () => { received.push({ headers: req.headers, body }); res.writeHead(reply); res.end(); }); });
  await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
  const hookUrl = `http://127.0.0.1:${(receiver.address() as { port: number }).port}/liwip`;
  const dispatcher = app.get(WebhookDispatcher);
  const verify = (secret: string, entry: { headers: IncomingHttpHeaders; body: string }) => {
    const [t, v1] = String(entry.headers["liwip-signature"]).split(",").map((part) => part.split("=")[1]);
    return v1 === createHmac("sha256", secret).update(`${t}.${entry.body}`).digest("hex");
  };
  try {
    // Keystone adds an endpoint for partner A's program; the secret is shown once.
    assert.equal((await as(keystone, "post", "/v1/admin/webhooks").send({ url: "http://hooks.example.com/x", programId: partnerA.client.id })).status, 400);
    assert.equal((await as(keystone, "post", "/v1/admin/webhooks").send({ url: hookUrl })).status, 400, "which partner");
    const created = ok(await as(keystone, "post", "/v1/admin/webhooks").send({ url: hookUrl, programId: partnerA.client.id, description: "Ops" }), 201).body;
    assert.match(created.secret, /^whsec_/);
    const endpointId = created.endpoint.id;
    const listed = ok(await as(keystone, "get", "/v1/admin/webhooks")).body.items.find((item: { id: string }) => item.id === endpointId);
    assert.equal(listed.programId, partnerA.client.id); assert.equal(JSON.stringify(listed).includes("whsec_"), false);

    // A package whose optional reference check may fail without failing the case.
    const code = `TEST_RESULT_${tag}`.toUpperCase();
    await db.verificationPackage.create({ data: { id: `pkg_result_${tag}`, code, version: 1, name: "Result rule", checks: [{ type: "CURRENT_ADDRESS", mode: "REQUIRED", execution: "MANUAL" }, { type: "REFERENCE_CHECK", mode: "OPTIONAL", execution: "MANUAL", onFail: "IGNORE" }] } });
    const opened = await api().post("/v1/applications").set("x-api-key", partnerA.rawKey).send({ packageCode: code, personal: { panNumber: "ABCDE1234F", nameAsAadhaar: "Result Person", submittedAddress: "Test Address" }, references: [{ name: "Referee One", phone: "9876543210" }], consent: { granted: true } });
    assert.equal(opened.status, 201, JSON.stringify(opened.body));
    const created_case = opened.body as { id: string };
    const checks = await eventually(() => db.verification.findMany({ where: { applicationId: created_case.id } }), (rows) => rows.length === 2 && rows.every((row) => row.status === "MANUAL_REVIEW"));
    const caseRow = await db.application.findUniqueOrThrow({ where: { id: created_case.id } });
    assert.equal(caseRow.finalResult, "REVIEW", "checks in review make the result Review");

    assert.ok((await dispatcher.runOnce()) >= 1);
    const firstEvents = received.map((entry) => JSON.parse(entry.body)).filter((event) => event.data.caseId === created_case.id);
    assert.ok(firstEvents.some((event) => event.type === "case.status_changed" && event.data.status === "MANUAL_REVIEW"));
    assert.ok(firstEvents.some((event) => event.type === "case.completed" && event.data.finalResult === "REVIEW"));
    assert.ok(received.every((entry) => verify(created.secret, entry)), "every body is signed with the endpoint's secret");
    assert.equal(received[0].headers["liwip-event"], JSON.parse(received[0].body).type);
    assert.equal(JSON.stringify(firstEvents).includes("Result Person"), false, "events carry no personal data");

    // Keystone clears the address and rejects the optional reference: the case passes.
    const address = checks.find((row) => row.type === "CURRENT_ADDRESS")!, reference = checks.find((row) => row.type === "REFERENCE_CHECK")!;
    ok(await as(keystone, "post", `/v1/admin/cases/${created_case.id}/checks/${address.id}/decision`).send({ decision: "VERIFIED" }));
    ok(await as(keystone, "post", `/v1/admin/cases/${created_case.id}/checks/${reference.id}/decision`).send({ decision: "FAILED", note: "Referee did not answer" }));
    const passed = await db.application.findUniqueOrThrow({ where: { id: created_case.id } });
    assert.equal(passed.status, "VERIFICATION_FAILED", "the case status still shows the failed check");
    assert.equal(passed.finalResult, "PASS", "but the package says that failure does not count"); assert.ok(passed.finalResultAt);
    received.length = 0;
    await dispatcher.runOnce();
    const completed = received.map((entry) => JSON.parse(entry.body)).find((event) => event.type === "case.completed");
    assert.equal(completed.data.finalResult, "PASS"); assert.equal(completed.data.caseId, created_case.id);

    // The JSON report, through the partner's API key and the admin app.
    const report = ok(await api().get(`/v1/applications/${created_case.id}/report`).set("x-api-key", partnerA.rawKey)).body;
    assert.equal(report.result.final, "PASS"); assert.deepEqual(report.result.because, []);
    assert.equal(report.subject.person.name, "Result Person"); assert.equal(report.subject.vehicle, null);
    assert.equal(report.sections.length, 1); assert.equal(report.sections[0].module, "PEOPLE");
    const referenceLine = report.sections[0].checks.find((check: { type: string }) => check.type === "REFERENCE_CHECK");
    assert.deepEqual([referenceLine.required, referenceLine.onFail, referenceLine.state, referenceLine.note], [false, "IGNORE", "DISCREPANCY", "Referee did not answer"]);
    assert.equal(JSON.stringify(report).includes("ABCDE1234F"), false, "no ID numbers in the report");
    assert.equal((await api().get(`/v1/applications/${created_case.id}/report`).set("x-api-key", partnerB.rawKey)).status, 404);
    assert.equal(ok(await as(keystone, "get", `/v1/admin/cases/${created_case.id}/report`)).body.result.final, "PASS");
    assert.ok((ok(await as(keystone, "get", "/v1/admin/cases?result=PASS&limit=100")).body.items as Array<{ id: string }>).some((item) => item.id === created_case.id));
    assert.equal(ok(await as(keystone, "get", `/v1/admin/cases/${created_case.id}`)).body.finalResult, "PASS");

    // A failing receiver: the delivery waits to retry; a manual retry sends it now.
    reply = 500; received.length = 0;
    const testDelivery = ok(await as(keystone, "post", `/v1/admin/webhooks/${endpointId}/test`), 201).body;
    await dispatcher.runOnce();
    let row = await db.webhookDelivery.findUniqueOrThrow({ where: { id: testDelivery.id } });
    assert.deepEqual([row.status, row.attempts, row.lastStatusCode], ["PENDING", 1, 500]); assert.ok(row.nextAttemptAt > new Date());
    assert.equal(await dispatcher.runOnce(), 0, "not due yet");
    reply = 200;
    ok(await as(keystone, "post", `/v1/admin/webhooks/deliveries/${testDelivery.id}/retry`));
    await dispatcher.runOnce();
    row = await db.webhookDelivery.findUniqueOrThrow({ where: { id: testDelivery.id } });
    assert.equal(row.status, "DELIVERED"); assert.equal(row.attempts, 2);
    assert.equal((await as(keystone, "post", `/v1/admin/webhooks/deliveries/${testDelivery.id}/retry`)).status, 409);
    assert.ok(ok(await as(keystone, "get", `/v1/admin/webhooks/${endpointId}/deliveries`)).body.items.some((item: { id: string; status: string }) => item.id === testDelivery.id && item.status === "DELIVERED"));

    // A rotated secret signs from then on; a disabled endpoint gets nothing.
    const rotated = ok(await as(keystone, "post", `/v1/admin/webhooks/${endpointId}/rotate-secret`)).body;
    assert.notEqual(rotated.secret, created.secret);
    received.length = 0;
    ok(await as(keystone, "post", `/v1/admin/webhooks/${endpointId}/test`), 201);
    await dispatcher.runOnce();
    assert.ok(verify(rotated.secret, received[0]) && !verify(created.secret, received[0]));
    ok(await as(keystone, "post", `/v1/admin/webhooks/${endpointId}/disable`));
    assert.equal((await as(keystone, "post", `/v1/admin/webhooks/${endpointId}/test`)).status, 409);
    const before = await db.webhookDelivery.count({ where: { endpointId } });
    await createCase(partnerA, code, "Another Person");
    assert.equal(await db.webhookDelivery.count({ where: { endpointId } }), before, "no events for a disabled endpoint");
  } finally {
    await new Promise((resolve) => receiver.close(resolve));
  }
});
test("disabled organizations cannot use keys, issue new keys or be silently reactivated", async () => {
  await db.client.update({ where: { id: partnerB.client.id }, data: { status: "INACTIVE" } });
  assert.equal((await api().get("/v1/usage").set("x-api-key", partnerB.rawKey)).status, 401);
  assert.equal((await issueKey(partnerB, { scopes: ["usage:read"] })).status, 403);
  await assert.rejects(new PartnerProvisioning(db).createPartner({ tenantSlug: partnerB.tenant.slug, tenantName: "Changed", clientCode: partnerB.client.code, clientName: "Changed" }));
  assert.equal((await db.client.findUniqueOrThrow({ where: { id: partnerB.client.id } })).status, "INACTIVE");
});
