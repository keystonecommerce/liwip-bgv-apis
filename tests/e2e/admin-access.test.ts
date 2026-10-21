import "reflect-metadata";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";

import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import request from "supertest";
import { EMAIL_SENDER, type EmailMessage } from "../../apps/verification-api/src/modules/staff-auth/email-sender";
import { ensureLiwipDirect, provisionPlatformAdmin } from "../../apps/verification-api/src/modules/admin-access/bootstrap";
import { issueLiveToken } from "../../apps/verification-api/src/modules/cards/card-token";

/**
 * Admin access layer: staff sign-in, CSRF, role-binding scope, tenant isolation between
 * two partners (cases, cards, users, audit rows), relationship end, verifier SCOPED vs
 * UNIVERSAL, public card checks and the deprecated X-Admin-Key routes.
 */
let app: INestApplication, db: PrismaClient;
const tag = randomUUID().replaceAll("-", "").slice(0, 12);
const adminKey = `test_admin_${tag}`;
const ORIGIN = "https://admin.test.liwip.example";
const COOKIE = "__Host-liwip_admin";
const emails: EmailMessage[] = [];
const api = () => request(app.getHttpServer());

interface Staff { token: string; csrf: string; userId: string; email: string }
interface Partner { id: string; programId: string; cases: Case[] }
interface Case { id: string; cardId: string; cardNumber: string; publicId: string; documentId: string; phone: string }

let keystone: Staff, partnerA: Partner, partnerB: Partner, adminA: Staff, adminB: Staff, operatorA: Staff, viewerA: Staff, ops: Staff;

const cookie = (staff: Staff) => `${COOKIE}=${staff.token}`;
function as(staff: Staff, method: "get" | "post" | "patch" | "put" | "delete", path: string, partnerId?: string) {
  let call = api()[method](path).set("Cookie", cookie(staff)).set("Origin", ORIGIN);
  if (method !== "get") call = call.set("x-csrf-token", staff.csrf);
  if (partnerId) call = call.set("x-partner-id", partnerId);
  return call;
}

async function session(token: string, email: string): Promise<Staff> {
  const response = await api().get("/v1/admin/auth/session").set("Cookie", `${COOKIE}=${token}`);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return { token, csrf: response.body.csrfToken, userId: response.body.user.id, email };
}

/** Signs in through the real email-code flow. */
async function signInByEmail(email: string): Promise<Staff> {
  const before = emails.length;
  const sent = await api().post("/v1/admin/auth/otp/send").set("Origin", ORIGIN).send({ email });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  const message = emails.slice(before).find((item) => item.kind === "otp" && item.to === email);
  assert.ok(message, "a code was emailed");
  const verified = await api().post("/v1/admin/auth/otp/verify").set("Origin", ORIGIN).send({ email, code: message!.variables.code });
  assert.equal(verified.status, 200, JSON.stringify(verified.body));
  const setCookie = String(verified.headers["set-cookie"]);
  const token = /__Host-liwip_admin=([^;]+)/.exec(setCookie)?.[1];
  assert.ok(token);
  return session(decodeURIComponent(token!), email);
}

/** A session row for an existing account (keeps the per-route sign-in throttles out of the way). */
async function signInDirect(email: string): Promise<Staff> {
  const user = await db.portalUser.findUniqueOrThrow({ where: { email } });
  const token = randomBytes(32).toString("base64url");
  await db.staffSession.create({ data: { id: `staff_session_${randomUUID()}`, userId: user.id, tokenHash: createHash("sha256").update(token).digest("hex"), sessionVersion: user.sessionVersion, authMethod: "otp", expiresAt: new Date(Date.now() + 3_600_000) } });
  return session(token, email);
}

/** Audit rows are written without blocking the request. */
async function eventually<T>(read: () => Promise<T>, accept: (value: T) => boolean, timeout = 5000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (true) { const value = await read(); if (accept(value) || Date.now() >= deadline) return value; await new Promise((resolve) => setTimeout(resolve, 25)); }
}

let phoneSeq = 0;
async function fixtureCase(tenantId: string, clientId: string, name: string): Promise<Case> {
  const id = `app_${tag}_${++phoneSeq}`;
  const phone = `9${String(Date.now() % 1_000_000_000).padStart(9, "0").slice(0, 7)}${String(phoneSeq).padStart(2, "0")}`;
  const cardNumber = `LIWIP-2026-${tag.slice(0, 6).toUpperCase()}${String(phoneSeq).padStart(4, "0")}`;
  const publicId = randomUUID();
  const now = new Date();
  await db.application.create({ data: {
    id, tenantId, clientId, status: "MANUAL_REVIEW", workerPhone: `91${phone}`, cardNumber,
    data: { personal: { phone, nameAsAadhaar: name, declaredName: name, dateOfBirth: "1991-02-03", panNumber: "ABCDE1234F", submittedAddress: "12 Test Street" }, identity: { source: "DIGILOCKER", sessionId: "s", status: "VERIFIED", fullName: name, dateOfBirth: "1991-02-03", address: "12 Test Street" } }
  } });
  await db.verification.createMany({ data: [
    { id: `ver_${id}_pan`, applicationId: id, tenantId, clientId, type: "PAN", status: "VERIFIED", provider: "surepass", completedAt: now },
    { id: `ver_${id}_court`, applicationId: id, tenantId, clientId, type: "ECOURTS_SEARCH", status: "MANUAL_REVIEW", provider: "surepass" }
  ] });
  const card = await db.verificationCard.create({ data: { id: `card_${id}`, applicationId: id, tenantId, clientId, cardNumber, publicId, status: "ACTIVE", expiresAt: new Date(Date.now() + 365 * 86_400_000) } });
  await db.workerPhoto.create({ data: { applicationId: id, tenantId, clientId, contentType: "image/jpeg", bytes: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) } });
  const document = await db.applicationDocument.create({ data: { id: `doc_${id}`, tenantId, clientId, applicationId: id, documentType: "PAN_CARD", status: "UPLOADED", bucket: "test-bucket", objectKey: `k/${id}`, originalFileName: "pan.pdf", contentType: "application/pdf", declaredSizeBytes: 10, expiresAt: new Date(Date.now() + 86_400_000) } });
  return { id, cardId: card.id, cardNumber, publicId, documentId: document.id, phone };
}

async function createPartner(suffix: string): Promise<Partner> {
  const created = await as(keystone, "post", "/v1/admin/partners").send({ slug: `test-${tag}-${suffix}`, name: `Partner ${suffix.toUpperCase()}`, legalName: `Partner ${suffix} Pvt Ltd`, gstin: "29ABCDE1234F1Z5", address: { line1: "1 Road", city: "Bengaluru", state: "Karnataka", pincode: "560001" }, contacts: [{ name: "Ops", email: "ops@example.com" }], logoUrl: "https://cdn.example.com/logo.png" });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const program = await as(keystone, "post", `/v1/admin/partners/${created.body.id}/programs`).send({ code: "DELIVERY", name: `Partner ${suffix} Delivery`, corporateCode: `${suffix.toUpperCase()}${tag.slice(0, 6).toUpperCase()}` });
  assert.equal(program.status, 201, JSON.stringify(program.body));
  const cases = [await fixtureCase(created.body.id, program.body.id, `Worker ${suffix.toUpperCase()} One`), await fixtureCase(created.body.id, program.body.id, `Worker ${suffix.toUpperCase()} Two`)];
  return { id: created.body.id, programId: program.body.id, cases };
}

async function invite(by: Staff, path: string, body: Record<string, unknown>, partnerId?: string) {
  const response = await as(by, "post", path, partnerId).send(body);
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body;
}

before(async () => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (!databaseUrl || !/test/i.test(new URL(databaseUrl).pathname)) throw new Error("TEST_DATABASE_URL must name a dedicated test database; tests never reset production data");
  if (!process.env.TEST_REDIS_URL) throw new Error("TEST_REDIS_URL is required for the dedicated queue test instance");
  const redis = new URL(process.env.TEST_REDIS_URL);
  process.env.DATABASE_URL = databaseUrl;
  process.env.REDIS_HOST = redis.hostname; process.env.REDIS_PORT = redis.port || "6379";
  process.env.NODE_ENV = "production"; process.env.ENABLE_INTERNAL_ROUTES = "false";
  process.env.ADMIN_API_KEY = adminKey;
  process.env.ADMIN_AUTH_SECRET = "test_only_admin_auth_secret_longer_than_32";
  process.env.WORKER_TOKEN_SECRET = "test_only_worker_token_secret_longer_than_32";
  process.env.ADMIN_PANEL_ORIGINS = ORIGIN;
  process.env.THROTTLE_LIMIT = "10000"; process.env.PARTNER_RATE_LIMIT = "10000";
  for (const name of ["LIMIT_STAFF_OTP_SEND_PER_IP_HOUR", "LIMIT_STAFF_SIGN_IN_PER_IP_15MIN", "LIMIT_CARD_VERIFY_PER_IP_MIN", "LIMIT_CARD_LOOKUP_PER_STAFF_HOUR"]) process.env[name] = "100000";
  execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy"], { env: process.env, stdio: "pipe" });
  db = new PrismaClient();
  const { AppModule } = await import("../../apps/verification-api/src/app.module");
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(EMAIL_SENDER).useValue({ send: async (message: EmailMessage) => { emails.push(message); } })
    .compile();
  app = module.createNestApplication(); app.useLogger(false); await app.init();

  await ensureLiwipDirect(db);
  await provisionPlatformAdmin(db, `keystone-${tag}@example.com`, "Keystone Admin");
  keystone = await signInByEmail(`keystone-${tag}@example.com`);
  partnerA = await createPartner("a");
  partnerB = await createPartner("b");
  await invite(keystone, `/v1/admin/partners/${partnerA.id}/admins`, { email: `admin-a-${tag}@example.com`, displayName: "Admin A" });
  await invite(keystone, `/v1/admin/partners/${partnerB.id}/admins`, { email: `admin-b-${tag}@example.com`, displayName: "Admin B" });
  adminA = await signInByEmail(`admin-a-${tag}@example.com`);
  adminB = await signInDirect(`admin-b-${tag}@example.com`);
  await invite(adminA, "/v1/admin/users", { email: `operator-a-${tag}@example.com`, displayName: "Operator A", roleKey: "PARTNER_OPERATOR" });
  await invite(adminA, "/v1/admin/users", { email: `viewer-a-${tag}@example.com`, displayName: "Viewer A", roleKey: "PARTNER_VIEWER" });
  await invite(adminB, "/v1/admin/users", { email: `operator-b-${tag}@example.com`, displayName: "Operator B", roleKey: "PARTNER_OPERATOR" });
  operatorA = await signInDirect(`operator-a-${tag}@example.com`);
  viewerA = await signInDirect(`viewer-a-${tag}@example.com`);
  await invite(keystone, "/v1/admin/staff", { email: `ops-${tag}@example.com`, displayName: "Ops", roleKey: "KEYSTONE_OPS_REVIEWER" });
  ops = await signInDirect(`ops-${tag}@example.com`);
});
after(async () => { if (app) await app.close(); if (db) await db.$disconnect(); });

test("staff sign in by email code into an httpOnly, Secure, SameSite=Lax cookie; codes are single use", async () => {
  const unknown = await api().post("/v1/admin/auth/otp/send").set("Origin", ORIGIN).send({ email: `nobody-${tag}@example.com` });
  assert.equal(unknown.status, 200, "same answer for unknown addresses");
  assert.ok(!emails.some((item) => item.to === `nobody-${tag}@example.com`));
  const email = `viewer-a-${tag}@example.com`;
  await api().post("/v1/admin/auth/otp/send").set("Origin", ORIGIN).send({ email });
  const code = emails.filter((item) => item.to === email && item.kind === "otp").at(-1)!.variables.code;
  const otp = await db.staffOtp.findFirstOrThrow({ where: { email }, orderBy: { createdAt: "desc" } });
  assert.ok(!otp.codeHash.includes(code), "only an HMAC is stored");
  assert.equal((await api().post("/v1/admin/auth/otp/verify").set("Origin", ORIGIN).send({ email, code: code === "000000" ? "111111" : "000000" })).status, 401);
  const ok = await api().post("/v1/admin/auth/otp/verify").set("Origin", ORIGIN).send({ email, code });
  assert.equal(ok.status, 200);
  const setCookie = String(ok.headers["set-cookie"]);
  for (const part of ["__Host-liwip_admin=", "HttpOnly", "Secure", "SameSite=Lax", "Path=/"]) assert.ok(setCookie.includes(part), `${part} in ${setCookie}`);
  assert.ok(!/Domain=/i.test(setCookie));
  assert.ok(ok.body.csrfToken);
  assert.equal((await api().post("/v1/admin/auth/otp/verify").set("Origin", ORIGIN).send({ email, code })).status, 401, "a code works once");
  assert.equal((await api().post("/v1/admin/auth/otp/send").set("Origin", "https://evil.example").send({ email })).status, 403, "sign-in from another origin");
  const me = await api().get("/v1/admin/auth/session").set("Cookie", cookie(keystone));
  assert.ok(me.body.access.global.includes("partners.manage"));
  assert.ok(me.body.access.allPartners.includes("cases.read"));
});

test("state-changing admin routes need the CSRF token and an allowed origin", async () => {
  const body = { slug: `csrf-${tag}`, name: "CSRF test" };
  assert.equal((await api().post("/v1/admin/partners").send(body)).status, 401, "no session");
  assert.equal((await api().post("/v1/admin/partners").set("Cookie", cookie(keystone)).send(body)).status, 403, "no CSRF token");
  assert.equal((await api().post("/v1/admin/partners").set("Cookie", cookie(keystone)).set("x-csrf-token", adminA.csrf).send(body)).status, 403, "another session's token");
  assert.equal((await api().post("/v1/admin/partners").set("Cookie", cookie(keystone)).set("x-csrf-token", keystone.csrf).set("Origin", "https://evil.example").send(body)).status, 403, "foreign origin");
  assert.equal((await api().get("/v1/admin/partners").set("Cookie", cookie(keystone))).status, 200, "reads need no token");
  assert.equal((await as(keystone, "post", "/v1/admin/partners").send(body)).status, 201);
});

test("partner management: profile, programs, unique corporate codes, disable and enable", async () => {
  const list = await as(keystone, "get", `/v1/admin/partners?search=${encodeURIComponent(`test-${tag}`)}`);
  assert.equal(list.status, 200);
  assert.deepEqual(Object.keys(list.body.meta).sort(), ["limit", "page", "total", "totalPages"]);
  assert.ok(list.body.items.some((item: { id: string }) => item.id === partnerA.id));
  const detail = await as(keystone, "get", `/v1/admin/partners/${partnerA.id}`);
  assert.equal(detail.body.gstin, "29ABCDE1234F1Z5");
  assert.equal(detail.body.programs.length, 1);
  const duplicate = await as(keystone, "post", `/v1/admin/partners/${partnerB.id}/programs`).send({ code: "OTHER", name: "Other", corporateCode: detail.body.programs[0].corporateCode });
  assert.equal(duplicate.status, 409, "corporate codes are unique across programs");
  assert.equal((await as(keystone, "patch", `/v1/admin/partners/${partnerA.id}`).send({ gstin: "not-a-gstin" })).status, 400);
  assert.equal((await as(keystone, "patch", `/v1/admin/partners/${partnerA.id}`).send({ legalName: "Partner A Private Limited" })).body.legalName, "Partner A Private Limited");
  const direct = await db.tenant.findUnique({ where: { slug: "liwip-direct" } });
  if (direct) assert.equal((await as(keystone, "post", `/v1/admin/partners/${direct.id}/disable`)).status, 400, "Liwip Direct stays on");
  // Partner staff cannot manage partners.
  assert.equal((await as(adminA, "get", "/v1/admin/partners")).status, 403);
  assert.equal((await as(adminA, "post", "/v1/admin/partners").send({ slug: `x-${tag}`, name: "X" })).status, 403);
  const own = await as(operatorA, "get", "/v1/admin/organisation");
  assert.equal(own.status, 200);
  assert.equal(own.body.id, partnerA.id);
  assert.ok(own.body.programs.every((program: { tenantId: string }) => program.tenantId === partnerA.id));
});

test("access comes only from role bindings: the legacy role column grants nothing", async () => {
  const email = `legacy-${tag}@example.com`;
  await db.portalUser.create({ data: { id: `legacy_${tag}`, email, displayName: "Legacy", role: "CORPORATE_ADMIN", tenantId: partnerA.id, status: "ACTIVE" } });
  const legacy = await signInDirect(email);
  assert.equal((await as(legacy, "get", "/v1/admin/cases")).status, 403);
  assert.equal((await as(legacy, "get", "/v1/admin/cases", partnerA.id)).status, 403);
  assert.equal((await as(legacy, "get", "/v1/admin/users")).status, 403);
});

test("two partners cannot read or change each other's cases", async () => {
  const [mine, theirs] = [partnerA.cases[0], partnerB.cases[0]];
  const list = await as(adminA, "get", "/v1/admin/cases");
  assert.equal(list.status, 200, JSON.stringify(list.body));
  assert.equal(list.body.meta.total, 2);
  assert.ok(list.body.items.every((item: { partner: { id: string } }) => item.partner.id === partnerA.id));
  assert.equal((await as(adminA, "get", `/v1/admin/cases?search=${theirs.phone}`)).body.meta.total, 0);
  assert.equal((await as(adminA, "get", `/v1/admin/cases?search=${theirs.cardNumber}`)).body.meta.total, 0);
  assert.equal((await as(adminA, "get", `/v1/admin/cases/${mine.id}`)).status, 200);
  assert.equal((await as(adminA, "get", `/v1/admin/cases/${theirs.id}`)).status, 404);
  assert.equal((await as(adminA, "get", `/v1/admin/cases/${theirs.id}`, partnerB.id)).status, 403, "x-partner-id cannot widen a partner binding");
  assert.equal((await as(adminA, "get", "/v1/admin/cases", partnerB.id)).status, 403);
  assert.equal((await as(adminA, "get", `/v1/admin/cases/${theirs.id}/documents/${theirs.documentId}/url`)).status, 404);
  assert.equal((await as(adminA, "get", `/v1/admin/cases/${mine.id}/documents/${theirs.documentId}/url`)).status, 404);
  assert.notEqual((await as(adminA, "get", `/v1/admin/cases/${mine.id}/documents/${mine.documentId}/url`)).status, 404, "own document reaches storage (unconfigured in tests)");
  assert.equal((await as(adminA, "post", `/v1/admin/cases/${theirs.id}/relationship/end`).send({ reason: "x" })).status, 404);
  assert.equal((await db.application.findUniqueOrThrow({ where: { id: theirs.id } })).relationshipStatus, "ACTIVE");
  const check = `ver_${theirs.id}_court`;
  assert.equal((await as(adminA, "post", `/v1/admin/cases/${theirs.id}/checks/${check}/decision`).send({ decision: "VERIFIED" })).status, 403, "partners cannot decide checks");
  assert.equal((await as(ops, "post", `/v1/admin/cases/${theirs.id}/checks/ver_${mine.id}_court/decision`, partnerB.id).send({ decision: "VERIFIED" })).status, 404, "a check id from another case");
  assert.equal((await db.verification.findUniqueOrThrow({ where: { id: check } })).status, "MANUAL_REVIEW");
  const detail = await as(viewerA, "get", `/v1/admin/cases/${mine.id}`);
  assert.equal(detail.status, 200);
  assert.ok(!JSON.stringify(detail.body).includes(mine.phone), "phone is masked");
  assert.equal((await as(viewerA, "get", `/v1/admin/cases/${mine.id}/documents/${mine.documentId}/url`)).status, 403, "viewers cannot open documents");
});

test("two partners cannot see or change each other's users", async () => {
  const teamA = await as(adminA, "get", "/v1/admin/users");
  assert.equal(teamA.status, 200);
  const emailsA = teamA.body.items.map((item: { email: string }) => item.email);
  assert.ok(emailsA.includes(`operator-a-${tag}@example.com`));
  assert.ok(!emailsA.some((email: string) => email.includes("-b-")), "no partner B staff");
  const operatorB = await db.portalUser.findUniqueOrThrow({ where: { email: `operator-b-${tag}@example.com` } });
  assert.equal((await as(adminA, "delete", `/v1/admin/users/${operatorB.id}`)).status, 404);
  assert.equal((await as(adminA, "put", `/v1/admin/users/${operatorB.id}/role`).send({ roleKey: "PARTNER_VIEWER" })).status, 404);
  assert.equal(await db.staffRoleBinding.count({ where: { userId: operatorB.id, tenantId: partnerB.id, roleKey: "PARTNER_OPERATOR" } }), 1);
  assert.equal((await as(adminA, "get", "/v1/admin/users", partnerB.id)).status, 403);
});

test("two partners cannot read each other's audit rows", async () => {
  const rowsA = await as(adminA, "get", "/v1/admin/audit-logs?limit=200");
  assert.equal(rowsA.status, 200);
  assert.ok(rowsA.body.items.length > 0);
  assert.ok(rowsA.body.items.every((row: { tenantId: string }) => row.tenantId === partnerA.id));
  const rowsB = await as(adminB, "get", "/v1/admin/audit-logs?limit=200");
  assert.ok(rowsB.body.items.every((row: { tenantId: string }) => row.tenantId === partnerB.id));
  assert.equal((await as(adminA, "get", "/v1/admin/audit-logs", partnerB.id)).status, 403);
  assert.equal((await as(operatorA, "get", "/v1/admin/audit-logs")).status, 403, "operators have no audit access");
  // Keystone sees every partner's rows, or one partner's with x-partner-id.
  const all = await as(keystone, "get", "/v1/admin/audit-logs?limit=200");
  assert.equal(all.status, 200);
  const onlyB = await as(keystone, "get", "/v1/admin/audit-logs?limit=200", partnerB.id);
  assert.ok(onlyB.body.items.every((row: { tenantId: string }) => row.tenantId === partnerB.id));
});

test("Keystone staff choose a partner with x-partner-id; the partner must be ACTIVE even for platform admins", async () => {
  const everyone = await as(keystone, "get", "/v1/admin/cases?limit=100");
  assert.equal(everyone.status, 200);
  const partners = new Set(everyone.body.items.map((item: { partner: { id: string } }) => item.partner.id));
  assert.ok(partners.has(partnerA.id) && partners.has(partnerB.id));
  const onlyA = await as(keystone, "get", "/v1/admin/cases", partnerA.id);
  assert.ok(onlyA.body.items.every((item: { partner: { id: string } }) => item.partner.id === partnerA.id));
  assert.equal((await as(keystone, "get", "/v1/admin/users")).status, 400, "team routes need a partner");
  assert.equal((await as(keystone, "get", "/v1/admin/cases", "tenant_does_not_exist")).status, 403);
  assert.equal((await as(keystone, "post", `/v1/admin/partners/${partnerB.id}/disable`)).status, 200);
  try {
    assert.equal((await as(keystone, "get", "/v1/admin/cases", partnerB.id)).status, 403);
    assert.equal((await as(adminB, "get", "/v1/admin/cases")).status, 403);
  } finally {
    assert.equal((await as(keystone, "post", `/v1/admin/partners/${partnerB.id}/enable`)).status, 200);
  }
  assert.equal((await as(adminB, "get", "/v1/admin/cases")).status, 200);
});

test("privilege escalation is refused", async () => {
  assert.equal((await as(operatorA, "post", "/v1/admin/users").send({ email: `x-${tag}@example.com`, displayName: "X", roleKey: "PARTNER_VIEWER" })).status, 403, "operators cannot invite");
  assert.equal((await as(adminA, "post", "/v1/admin/users").send({ email: `x-${tag}@example.com`, displayName: "X", roleKey: "KEYSTONE_PLATFORM_ADMIN" })).status, 400);
  assert.equal((await as(adminA, "post", "/v1/admin/staff").send({ email: `x-${tag}@example.com`, displayName: "X", roleKey: "KEYSTONE_READ_ONLY" })).status, 403);
  assert.equal((await as(ops, "post", "/v1/admin/staff").send({ email: `x-${tag}@example.com`, displayName: "X", roleKey: "KEYSTONE_READ_ONLY" })).status, 403, "ops reviewers cannot manage staff");
  assert.equal((await as(ops, "post", "/v1/admin/users", partnerA.id).send({ email: `x-${tag}@example.com`, displayName: "X", roleKey: "PARTNER_VIEWER" })).status, 403, "ops reviewers cannot manage partner teams");
  const adminAId = adminA.userId;
  assert.equal((await as(adminA, "delete", `/v1/admin/users/${adminAId}`)).status, 400, "cannot remove yourself");
  assert.equal((await as(ops, "post", `/v1/admin/staff/${keystone.userId}/disable`)).status, 403);
  assert.ok(!(await db.portalUser.findUniqueOrThrow({ where: { email: `x-${tag}@example.com` } }).catch(() => null)), "no account was created");
  // A partner admin changes a teammate's role within their own partner.
  assert.equal((await as(adminA, "put", `/v1/admin/users/${viewerA.userId}/role`).send({ roleKey: "PARTNER_OPERATOR" })).status, 200);
  assert.equal((await as(adminA, "put", `/v1/admin/users/${viewerA.userId}/role`).send({ roleKey: "PARTNER_VIEWER" })).status, 200);
});

test("a worker who left keeps their card; the partner sees the case only as of the end date", async () => {
  const leaver = partnerA.cases[1];
  assert.equal((await as(viewerA, "post", `/v1/admin/cases/${leaver.id}/relationship/end`).send({})).status, 403, "viewers cannot offboard");
  const ended = await as(adminA, "post", `/v1/admin/cases/${leaver.id}/relationship/end`).send({ reason: "Left the fleet" });
  assert.equal(ended.status, 200, JSON.stringify(ended.body));
  assert.equal((await as(adminA, "post", `/v1/admin/cases/${leaver.id}/relationship/end`).send({})).status, 409);
  await new Promise((resolve) => setTimeout(resolve, 20));
  // Later activity on the worker's own case: a reviewer decides, a check and a document are added.
  assert.equal((await as(ops, "post", `/v1/admin/cases/${leaver.id}/checks/ver_${leaver.id}_court/decision`, partnerA.id).send({ decision: "VERIFIED" })).status, 200);
  await db.verification.create({ data: { id: `ver_${leaver.id}_dl`, applicationId: leaver.id, tenantId: partnerA.id, clientId: partnerA.programId, type: "DRIVING_LICENSE", status: "VERIFIED", provider: "surepass", completedAt: new Date() } });
  await db.applicationDocument.create({ data: { id: `doc_${leaver.id}_late`, tenantId: partnerA.id, clientId: partnerA.programId, applicationId: leaver.id, documentType: "DRIVING_LICENCE", status: "UPLOADED", bucket: "test-bucket", objectKey: `k/${leaver.id}/late`, originalFileName: "dl.pdf", contentType: "application/pdf", declaredSizeBytes: 10, expiresAt: new Date(Date.now() + 86_400_000) } });

  const partnerView = await as(adminA, "get", `/v1/admin/cases/${leaver.id}`);
  assert.equal(partnerView.status, 200);
  assert.equal(partnerView.body.view, "AS_OF_RELATIONSHIP_END");
  assert.equal(partnerView.body.status, "MANUAL_REVIEW");
  assert.ok(!partnerView.body.checks.some((check: { type: string }) => check.type === "DRIVING_LICENSE"));
  assert.equal(partnerView.body.checks.find((check: { type: string }) => check.type === "ECOURTS_SEARCH").state, "NEEDS_REVIEW");
  assert.ok(!partnerView.body.documents.some((document: { id: string }) => document.id === `doc_${leaver.id}_late`));
  const endedAt = new Date(partnerView.body.relationship.endedAt).getTime();
  assert.ok(partnerView.body.timeline.every((event: { at: string }) => new Date(event.at).getTime() <= endedAt), "no later events");
  assert.equal((await as(adminA, "get", `/v1/admin/cases/${leaver.id}/documents/doc_${leaver.id}_late/url`)).status, 404);
  const listed = await as(adminA, "get", "/v1/admin/cases?state=MANUAL_REVIEW&relationship=ENDED");
  assert.equal(listed.body.meta.total, 1, "filters use the status at the end date");
  assert.equal((await as(adminA, "get", "/v1/admin/cases?checkType=DRIVING_LICENSE")).body.meta.total, 0);

  const keystoneView = await as(keystone, "get", `/v1/admin/cases/${leaver.id}`);
  assert.equal(keystoneView.body.view, "LIVE");
  assert.ok(keystoneView.body.checks.some((check: { type: string }) => check.type === "DRIVING_LICENSE"));
  assert.notEqual(keystoneView.body.status, "MANUAL_REVIEW");

  const card = await db.verificationCard.findUniqueOrThrow({ where: { id: leaver.cardId } });
  assert.equal(card.status, "ACTIVE", "the worker's card stays valid");
  const publicCheck = await api().get(`/v1/public/cards/verify/${leaver.publicId}`);
  assert.equal(publicCheck.status, 200);
  assert.equal(publicCheck.body.valid, true);
});

test("public card check: minimal data only, every scan logged, bad codes refused", async () => {
  const target = partnerB.cases[0];
  const live = issueLiveToken(target.publicId);
  const before = await db.cardScan.count({ where: { cardId: target.cardId } });
  const response = await api().get(`/v1/public/cards/verify/${encodeURIComponent(live.token)}`);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.deepEqual(Object.keys(response.body).sort(), ["checksPassed", "name", "photo", "status", "valid", "validUntil", "view"]);
  assert.equal(response.body.name, "Worker B One");
  assert.deepEqual(response.body.checksPassed, ["IDENTITY"]);
  const text = JSON.stringify(response.body);
  for (const secret of [target.phone, "1991-02-03", "ABCDE1234F", "Test Street", target.cardNumber]) assert.ok(!text.includes(secret), secret);
  const scans = await db.cardScan.findMany({ where: { cardId: target.cardId }, orderBy: { scannedAt: "desc" } });
  assert.equal(scans.length, before + 1);
  assert.equal(scans[0].via, "APP");
  assert.equal(scans[0].viewerType, "PUBLIC");
  assert.equal(scans[0].tenantId, partnerB.id);
  assert.equal((await api().get(`/v1/public/cards/verify/${randomUUID()}`)).status, 404);
  assert.equal((await api().get("/v1/public/cards/verify/l1.not.a.token")).status, 404);
});

test("partner staff scanning a card: own worker gets the full case, another partner's worker the public view", async () => {
  const own = await as(operatorA, "post", "/v1/admin/cards/lookup").send({ token: partnerA.cases[0].publicId });
  assert.equal(own.status, 200, JSON.stringify(own.body));
  assert.equal(own.body.view, "FULL");
  assert.equal(own.body.case.id, partnerA.cases[0].id);
  const other = await as(operatorA, "post", "/v1/admin/cards/lookup").send({ cardNumber: partnerB.cases[0].cardNumber });
  assert.equal(other.status, 200);
  assert.equal(other.body.view, "PUBLIC");
  assert.equal(other.body.case, undefined);
  assert.equal(other.body.cardNumber, undefined);
  const scan = await db.cardScan.findFirstOrThrow({ where: { cardId: partnerB.cases[0].cardId, viewerUserId: operatorA.userId } });
  assert.equal(scan.view, "PUBLIC");
  assert.equal(scan.viewerTenantId, partnerA.id);
  assert.equal((await as(operatorA, "post", "/v1/admin/cards/lookup").send({})).status, 400);
  assert.equal((await as(operatorA, "post", "/v1/admin/cards/lookup").send({ token: "x", cardNumber: "y" })).status, 400);
});

test("verifiers: SCOPED sees scanned or granted cards only, UNIVERSAL any card; every lookup logged; revocable", async () => {
  const [a0, a1] = partnerA.cases;
  const [b0, b1] = partnerB.cases;
  assert.equal((await as(adminA, "post", "/v1/admin/verifiers").send({ email: `v-${tag}@example.com`, displayName: "V", level: "UNIVERSAL" })).status, 403, "only Keystone creates verifiers");
  const scopedCreated = await as(keystone, "post", "/v1/admin/verifiers").send({ email: `scoped-${tag}@example.com`, displayName: "Scoped Verifier", organisation: "Gate Co", level: "SCOPED", cardNumbers: [b1.cardNumber] });
  assert.equal(scopedCreated.status, 201, JSON.stringify(scopedCreated.body));
  const universalCreated = await as(keystone, "post", "/v1/admin/verifiers").send({ email: `universal-${tag}@example.com`, displayName: "Universal Verifier", level: "UNIVERSAL", expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
  assert.equal(universalCreated.status, 201);
  assert.equal((await as(keystone, "post", "/v1/admin/verifiers").send({ email: `scoped-${tag}@example.com`, displayName: "Again", level: "SCOPED" })).status, 409);
  const scoped = await signInDirect(`scoped-${tag}@example.com`);
  const universal = await signInDirect(`universal-${tag}@example.com`);

  // SCOPED: by number only for granted (or already scanned) cards; a QR scan works for any card.
  assert.equal((await as(scoped, "post", "/v1/admin/cards/lookup").send({ cardNumber: a0.cardNumber })).status, 403);
  const granted = await as(scoped, "post", "/v1/admin/cards/lookup").send({ cardNumber: b1.cardNumber });
  assert.equal(granted.status, 200);
  assert.equal(granted.body.view, "VERIFIER");
  assert.equal(granted.body.cardNumber, b1.cardNumber);
  assert.ok(!JSON.stringify(granted.body).includes(b1.phone));
  const scanned = await as(scoped, "post", "/v1/admin/cards/lookup").send({ token: a0.publicId });
  assert.equal(scanned.status, 200);
  assert.equal(scanned.body.view, "VERIFIER");
  assert.equal((await as(scoped, "post", "/v1/admin/cards/lookup").send({ cardNumber: a0.cardNumber })).status, 200, "a scanned card can be looked up by number later");
  assert.equal((await as(scoped, "post", "/v1/admin/cards/lookup").send({ cardNumber: a1.cardNumber })).status, 403);

  // UNIVERSAL: any card by number or QR.
  for (const card of [a1, b0]) {
    const response = await as(universal, "post", "/v1/admin/cards/lookup").send({ cardNumber: card.cardNumber });
    assert.equal(response.status, 200);
    assert.equal(response.body.view, "VERIFIER");
  }

  // Lookups only: no case listing, no search, no partner data.
  for (const path of ["/v1/admin/cases", `/v1/admin/cases/${a0.id}`, "/v1/admin/users", "/v1/admin/audit-logs", "/v1/admin/partners"]) {
    assert.equal((await as(universal, "get", path)).status, 403, path);
  }

  const lookups = await as(keystone, "get", `/v1/admin/verifiers/${scoped.userId}/lookups`);
  assert.equal(lookups.status, 200);
  assert.equal(lookups.body.meta.total, 3, "every successful lookup has a scan row");
  const denied = await eventually(() => db.auditLog.count({ where: { actorUserId: scoped.userId, action: "cards.lookup", outcome: "CLIENT_ERROR" } }), (count) => count >= 2);
  assert.equal(denied, 2, "refused lookups are audited too");

  // Expiry and revocation.
  await db.verifierAccess.update({ where: { userId: universal.userId }, data: { expiresAt: new Date(Date.now() - 1000) } });
  assert.equal((await as(universal, "post", "/v1/admin/cards/lookup").send({ cardNumber: a1.cardNumber })).status, 403);
  assert.equal((await as(keystone, "post", `/v1/admin/verifiers/${scoped.userId}/revoke`)).status, 200);
  assert.equal((await as(scoped, "post", "/v1/admin/cards/lookup").send({ cardNumber: b1.cardNumber })).status, 401, "revocation ends the verifier's sessions");
});

test("bumping sessionVersion revokes every session; disabled staff are signed out", async () => {
  const email = `operator-a-${tag}@example.com`;
  const first = await signInDirect(email);
  const second = await signInDirect(email);
  assert.equal((await as(first, "post", "/v1/admin/auth/logout-all")).status, 200);
  assert.equal((await as(second, "get", "/v1/admin/cases")).status, 401);
  assert.equal((await as(first, "get", "/v1/admin/cases")).status, 401);
  const third = await signInDirect(email);
  assert.equal((await as(third, "post", "/v1/admin/auth/logout")).status, 200);
  assert.equal((await as(third, "get", "/v1/admin/cases")).status, 401);
  const victim = await signInDirect(`ops-${tag}@example.com`);
  assert.equal((await as(keystone, "post", `/v1/admin/staff/${victim.userId}/disable`)).status, 200);
  assert.equal((await as(victim, "get", "/v1/admin/cases")).status, 401);
  assert.equal((await api().post("/v1/admin/auth/otp/send").set("Origin", ORIGIN).send({ email: `ops-${tag}@example.com` })).status, 200);
  assert.ok(!emails.some((item) => item.to === `ops-${tag}@example.com` && item.kind === "otp"), "no code for a disabled account");
});

test("partner admins remove their own team members", async () => {
  const removed = await as(adminA, "delete", `/v1/admin/users/${viewerA.userId}`);
  assert.equal(removed.status, 200);
  assert.equal((await as(viewerA, "get", "/v1/admin/cases")).status, 403, "access ends with the binding");
});

test("legacy X-Admin-Key routes keep working and are marked deprecated", async () => {
  const response = await api().get("/admin/partners").set("x-admin-key", adminKey);
  assert.equal(response.status, 200);
  assert.equal(response.headers.deprecation, "true");
  assert.equal((await api().get("/admin/partners")).status, 401);
});
