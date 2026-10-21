import "reflect-metadata";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";

import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import request from "supertest";
import { EMAIL_SENDER } from "../../apps/verification-api/src/modules/staff-auth/email-sender";
import { ensureLiwipDirect, provisionPlatformAdmin } from "../../apps/verification-api/src/modules/admin-access/bootstrap";
import { cashfreeSignature, type CashfreeOrder, type CashfreeOrderInput, type PaymentGateway, PAYMENT_GATEWAY } from "../../apps/verification-api/src/modules/billing/cashfree.client";
import { INVITE_SENDER, type InviteMessage } from "../../apps/verification-api/src/modules/billing/invite-sender";
import { ORDER_CODE } from "../../apps/verification-api/src/modules/billing/order-code";
import { CatalogService } from "../../apps/verification-api/src/modules/billing/catalog.service";
import { OrdersService } from "../../apps/verification-api/src/modules/billing/orders.service";
import { QuoteService } from "../../apps/verification-api/src/modules/billing/quote.service";
import { periodRange, previousPeriod } from "../../apps/verification-api/src/modules/billing/billing-config";
import { PartnerProvisioning } from "../../apps/verification-api/src/common/security/partner-provisioning";
import { issueWorkerToken } from "../../apps/verification-api/src/common/auth/worker-token";

/**
 * Packages and prices set by Keystone, a partner's quote and Cashfree checkout (fake gateway),
 * the signed webhook, seats, bulk upload, invites and a refund that takes seats back.
 */
let app: INestApplication, db: PrismaClient;
const tag = randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase();
const ORIGIN = "https://admin.test.liwip.example";
const COOKIE = "__Host-liwip_admin";
const SECRET = "test_only_cashfree_secret";
// Check types are tagged so rates from earlier runs on the same test database never interfere.
const RIDER = `RIDER_${tag}`, COURT = `COURT_${tag}`, PAN = `PAN_${tag}`, FIELD = `FIELD_${tag}`;
const api = () => request(app.getHttpServer());

interface Staff { token: string; csrf: string; userId: string }
let keystone: Staff, adminA: Staff, viewerA: Staff, adminB: Staff;
let partnerA = "", programA = "", partnerB = "";

/** Cashfree stand-in: orders live in memory; tests flip them to PAID. */
const gatewayOrders = new Map<string, CashfreeOrder & { input: CashfreeOrderInput }>();
const refunds: Array<{ orderId: string; refundId: string; amount: string }> = [];
const gateway: PaymentGateway = {
  mode: "sandbox",
  async createOrder(input) {
    const order = { order_id: input.orderId, order_status: "ACTIVE", payment_session_id: `session_${input.orderId}`, order_amount: Number(input.amount), input };
    gatewayOrders.set(input.orderId, order);
    return order;
  },
  async getOrder(orderId) { const order = gatewayOrders.get(orderId); if (!order) throw new Error("no such order"); return order; },
  async getPayments(orderId) { return gatewayOrders.get(orderId)?.order_status === "PAID" ? [{ cf_payment_id: `cfp_${orderId}`, payment_status: "SUCCESS", payment_group: "upi" }] : []; },
  async createRefund(orderId, refund) { refunds.push({ orderId, refundId: refund.refundId, amount: refund.amount }); return { refund_id: refund.refundId, refund_status: "PENDING" }; },
  verifyWebhook(rawBody, timestamp, signature) { return Boolean(timestamp && signature) && cashfreeSignature(rawBody, timestamp, SECRET) === signature; }
};
const sent: InviteMessage[] = [];

function as(staff: Staff, method: "get" | "post" | "patch" | "put", path: string, partnerId?: string) {
  let call = api()[method](path).set("Cookie", `${COOKIE}=${staff.token}`).set("Origin", ORIGIN);
  if (method !== "get") call = call.set("x-csrf-token", staff.csrf);
  if (partnerId) call = call.set("x-partner-id", partnerId);
  return call;
}

async function signIn(email: string): Promise<Staff> {
  const user = await db.portalUser.findUniqueOrThrow({ where: { email } });
  const token = randomBytes(32).toString("base64url");
  await db.staffSession.create({ data: { id: `staff_session_${randomUUID()}`, userId: user.id, tokenHash: createHash("sha256").update(token).digest("hex"), sessionVersion: user.sessionVersion, authMethod: "otp", expiresAt: new Date(Date.now() + 3_600_000) } });
  const response = await api().get("/v1/admin/auth/session").set("Cookie", `${COOKIE}=${token}`);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return { token, csrf: response.body.csrfToken, userId: response.body.user.id };
}

function ok<T extends { status: number; body: unknown }>(response: T, status = 200): T {
  assert.equal(response.status, status, JSON.stringify(response.body));
  return response;
}

async function webhook(orderId: string, key = randomUUID(), signatureFor = SECRET) {
  const body = JSON.stringify({ type: "PAYMENT_SUCCESS_WEBHOOK", data: { order: { order_id: orderId } } });
  const timestamp = String(Math.floor(Date.now() / 1000));
  return api().post("/v1/payments/cashfree/webhook").set("Content-Type", "application/json").set("x-webhook-timestamp", timestamp)
    .set("x-webhook-signature", cashfreeSignature(Buffer.from(body), timestamp, signatureFor)).set("x-idempotency-key", key).send(body);
}

const seatsOf = async (staff: Staff, code = RIDER) => (await as(staff, "get", "/v1/admin/seats")).body.items.find((item: { packageCode: string }) => item.packageCode === code);
const phone = (n: number) => `98${String(Date.now()).slice(-6)}${String(n).padStart(2, "0")}`;

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
  process.env.THROTTLE_LIMIT = "10000"; process.env.PARTNER_RATE_LIMIT = "10000";
  process.env.BILLING_JOBS = "off"; process.env.BILLING_SELLER_STATE = "Karnataka"; process.env.BILLING_USAGE_START = "2020-01-01T00:00:00Z";
  process.env.WORKER_APP_URL = "https://app.test.liwip.example"; process.env.INVITE_LINK_BASE = "https://l.test.liwip.example";
  execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy"], { env: process.env, stdio: "pipe" });
  db = new PrismaClient();
  const { AppModule } = await import("../../apps/verification-api/src/app.module");
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(EMAIL_SENDER).useValue({ send: async () => undefined })
    .overrideProvider(PAYMENT_GATEWAY).useValue(gateway)
    .overrideProvider(INVITE_SENDER).useValue({ send: async (message: InviteMessage) => { sent.push(message); return { channel: "WHATSAPP", messageId: `m${sent.length}`, status: "SENT" }; } })
    .compile();
  app = module.createNestApplication({ rawBody: true }); app.useLogger(false); await app.init();

  await ensureLiwipDirect(db);
  await provisionPlatformAdmin(db, `keystone-pay-${tag.toLowerCase()}@example.com`, "Keystone Admin");
  keystone = await signIn(`keystone-pay-${tag.toLowerCase()}@example.com`);
  const partner = async (suffix: string, state: string) => ok(await as(keystone, "post", "/v1/admin/partners").send({ slug: `pay-${tag.toLowerCase()}-${suffix}`, name: `Pay ${suffix}`, legalName: `Pay ${suffix} Pvt Ltd`, address: { line1: "1 Road", city: "City", state, pincode: "560001" }, contacts: [{ name: "Ops", email: "ops@example.com", phone: "+91 98450 12345" }] }), 201).body.id as string;
  partnerA = await partner("a", "Karnataka");
  partnerB = await partner("b", "Maharashtra");
  programA = ok(await as(keystone, "post", `/v1/admin/partners/${partnerA}/programs`).send({ code: "DELIVERY", name: "Pay A Delivery", corporateCode: `PA${tag.slice(0, 6)}` }), 201).body.id;
  ok(await as(keystone, "post", `/v1/admin/partners/${partnerA}/admins`).send({ email: `pay-admin-a-${tag.toLowerCase()}@example.com`, displayName: "Admin A" }), 201);
  ok(await as(keystone, "post", `/v1/admin/partners/${partnerB}/admins`).send({ email: `pay-admin-b-${tag.toLowerCase()}@example.com`, displayName: "Admin B" }), 201);
  adminA = await signIn(`pay-admin-a-${tag.toLowerCase()}@example.com`);
  adminB = await signIn(`pay-admin-b-${tag.toLowerCase()}@example.com`);
  ok(await as(adminA, "post", "/v1/admin/users").send({ email: `pay-viewer-a-${tag.toLowerCase()}@example.com`, displayName: "Viewer A", roleKey: "PARTNER_VIEWER" }), 201);
  viewerA = await signIn(`pay-viewer-a-${tag.toLowerCase()}@example.com`);
});
after(async () => { if (app) await app.close(); if (db) await db.$disconnect(); });

test("Keystone sets packages, check prices, add-on checks, a bulk tier and a partner price; partners only read", async () => {
  ok(await as(keystone, "post", "/v1/admin/packages").send({ code: RIDER, name: "Rider", role: "rider", listPricePaise: 49_900, checks: [{ type: PAN }, { type: "DRIVING_LICENSE" }] }), 201);
  assert.equal((await as(keystone, "post", "/v1/admin/packages").send({ code: `ADDON_${tag}`, name: "Old style add-on", kind: "ADD_ON", listPricePaise: 15_000, checks: [{ type: COURT }] })).status, 400, "add-ons are check prices now");
  assert.equal((await as(keystone, "put", `/v1/admin/packages/${RIDER}/add-ons`).send({ addOnChecks: [COURT] })).status, 400, "an add-on check needs a list price first");
  ok(await as(keystone, "post", "/v1/admin/check-rates").send({ checkType: COURT, unitPricePaise: 15_000 }), 201);
  ok(await as(keystone, "post", "/v1/admin/check-rates").send({ checkType: PAN, unitPricePaise: 500 }), 201);
  ok(await as(keystone, "post", "/v1/admin/check-rates").send({ tenantId: partnerA, checkType: PAN, unitPricePaise: 400 }), 201);
  assert.equal((await as(keystone, "post", "/v1/admin/check-rates").send({ checkType: PAN, unitPricePaise: 50 })).status, 400);
  assert.equal((await as(keystone, "put", `/v1/admin/packages/${RIDER}/add-ons`).send({ addOnChecks: [PAN] })).status, 400, "a check already in the package is not an add-on");
  assert.equal((await as(keystone, "post", "/v1/admin/packages").send({ code: RIDER, name: "Again", listPricePaise: 1, checks: [{ type: "PAN" }] })).status, 409);
  assert.equal((await as(keystone, "post", "/v1/admin/packages").send({ code: `BAD_${tag}`, name: "Bad", listPricePaise: 100, checks: [] })).status, 400);
  ok(await as(keystone, "post", `/v1/admin/packages/${RIDER}/publish`));
  ok(await as(keystone, "put", `/v1/admin/packages/${RIDER}/add-ons`).send({ addOnChecks: [COURT] }));
  ok(await as(keystone, "post", "/v1/admin/discount-rules").send({ packageCode: RIDER, minQty: 50, percentOffBps: 1000 }), 201);
  ok(await as(keystone, "post", `/v1/admin/partners/${partnerA}/prices`).send({ packageCode: RIDER, unitPricePaise: 45_000 }), 201);

  // A new draft does not change what partners buy until it is published.
  ok(await as(keystone, "put", `/v1/admin/packages/${RIDER}/draft`).send({ listPricePaise: 59_900 }));
  const listed = ok(await as(keystone, "get", "/v1/admin/packages")).body;
  assert.ok(JSON.stringify(listed).includes(RIDER));

  for (const path of ["/v1/admin/packages", "/v1/admin/discount-rules", "/v1/admin/check-rates", "/v1/admin/revenue"]) assert.equal((await as(adminA, "get", path)).status, 403, path);
  assert.equal((await as(adminA, "post", `/v1/admin/partners/${partnerA}/prices`).send({ packageCode: RIDER, unitPricePaise: 1 })).status, 403);
  const catalogue = ok(await as(adminA, "get", "/v1/admin/catalog")).body;
  const rider = catalogue.packages.find((item: { code: string }) => item.code === RIDER);
  assert.equal(rider.unitPricePaise, 45_000);
  assert.deepEqual(rider.addOns, [], "company seats carry no add-ons");
  assert.deepEqual(catalogue.checkPrices.find((item: { checkType: string }) => item.checkType === PAN), { checkType: PAN, unitPricePaise: 400, own: true }, "a partner sees the check prices its API usage is billed at");
  const direct = await db.tenant.findUniqueOrThrow({ where: { slug: "liwip-direct" } });
  const forIndividuals = await app.get(CatalogService).catalogFor(null);
  assert.deepEqual(forIndividuals.packages.find((item) => item.code === RIDER)?.addOns, [{ checkType: COURT, unitPricePaise: 15_000 }]);
  assert.ok(direct.id);
});

let orderId = "";
test("a partner's quote prices server-side: partner price, bulk tier, CGST/SGST in state", async () => {
  assert.equal((await as(viewerA, "post", "/v1/admin/quotes").send({ lines: [{ packageCode: RIDER, quantity: 100 }] })).status, 403, "viewers cannot buy");
  assert.equal((await as(adminA, "post", "/v1/admin/quotes").send({ lines: [{ packageCode: RIDER, quantity: 0 }] })).status, 400);
  assert.equal((await as(adminA, "post", "/v1/admin/quotes").send({ lines: [{ packageCode: COURT, quantity: 1 }] })).status, 404, "a check is not a package");
  assert.equal((await as(adminA, "post", "/v1/admin/quotes").send({ lines: [{ packageCode: RIDER, quantity: 100, addOns: [COURT] }] })).status, 400, "seats carry no add-ons");
  const quote = ok(await as(adminA, "post", "/v1/admin/quotes").send({ lines: [{ packageCode: RIDER, quantity: 100, unitPricePaise: 1 }] }), 201).body;
  assert.equal(quote.subtotalPaise, 4_500_000, "45,000 partner price x100; a client-sent price is ignored");
  assert.equal(quote.discountPaise, 450_000);
  assert.equal(quote.lines[0].packagePaise, 4_050_000);
  assert.equal(quote.cgstPaise + quote.sgstPaise, 729_000);
  assert.equal(quote.igstPaise, 0);
  assert.equal(quote.totalPaise, 4_779_000);

  const quoteB = ok(await as(adminB, "post", "/v1/admin/quotes").send({ lines: [{ packageCode: RIDER, quantity: 10 }] }), 201).body;
  assert.equal(quoteB.subtotalPaise, 499_000, "list price and no tier below 50");
  assert.equal(quoteB.igstPaise, 89_820, "another state pays IGST");
  assert.equal((await as(adminB, "post", "/v1/admin/orders").set("Idempotency-Key", `idem_${tag}_cross_partner`).send({ quoteId: quote.id })).status, 404, "a quote is only for its partner");

  assert.equal((await as(adminA, "post", "/v1/admin/orders").send({ quoteId: quote.id })).status, 400, "Idempotency-Key is required");
  const key = `idem_${tag}_order_a_1`;
  const order = ok(await as(adminA, "post", "/v1/admin/orders").set("Idempotency-Key", key).send({ quoteId: quote.id })).body;
  assert.match(order.orderId, ORDER_CODE);
  assert.equal(order.totalPaise, 4_779_000);
  assert.equal(order.paymentSessionId, `session_${order.orderId}`);
  assert.equal(gatewayOrders.get(order.orderId)!.input.amount, "47790.00");
  const again = ok(await as(adminA, "post", "/v1/admin/orders").set("Idempotency-Key", key).send({ quoteId: quote.id })).body;
  assert.equal(again.orderId, order.orderId, "a retried checkout is the same order");
  orderId = order.orderId;

  assert.equal((await as(adminB, "get", `/v1/admin/orders/${orderId}`)).status, 404, "partners never see each other's orders");
  assert.equal(ok(await as(adminA, "get", `/v1/admin/orders/${orderId}`)).body.status, "PENDING_PAYMENT");
  assert.equal((await as(viewerA, "get", `/v1/admin/orders/${orderId}`)).status, 403, "billing is for partner admins, not viewers");
});

test("only a correctly signed webhook marks the order paid; repeats change nothing", async () => {
  gatewayOrders.get(orderId)!.order_status = "PAID";
  assert.equal((await webhook(orderId, randomUUID(), "wrong-secret")).status, 400);
  assert.equal(await seatsOf(adminA), undefined, "no seats before a valid notice");
  const key = randomUUID();
  ok(await webhook(orderId, key));
  assert.equal(ok(await webhook(orderId, key)).body.duplicate, true);
  ok(await webhook(orderId));
  const order = ok(await as(adminA, "get", `/v1/admin/orders/${orderId}`)).body;
  assert.equal(order.status, "PAID");
  assert.match(order.invoice.number, /^LBV\/\d{4}-\d{2}\/\d{5}$/);
  const invoice = await db.invoice.findUniqueOrThrow({ where: { orderId } });
  assert.equal(invoice.sellerGstin, "29AAMCK2232K1Z9");
  assert.equal(invoice.sellerState, "Karnataka");
  assert.equal(invoice.sacCode, "998521");
  assert.equal(order.payments.length, 1);
  const seats = await seatsOf(adminA);
  assert.equal(seats.available, 100);
  assert.equal(seats.purchased, 100);
  const events = await db.paymentWebhookEvent.findMany({ where: { orderId } });
  assert.ok(events.some((event) => !event.signatureValid), "rejected notices are kept for review");
});

let readyInvite = "";
test("bulk upload checks every row, sending reserves seats, cancelling gives one back", async () => {
  const [one, two, three] = [phone(1), phone(2), phone(3)];
  const csv = `name,mobile\nRavi Kumar,${one}\n"Asha Rao",+91 ${two}\nRavi Again,${one}\nNo Number,12345\nX,${three}\n`;
  const upload = ok(await as(adminA, "post", "/v1/admin/bulk-uploads").send({ programId: programA, packageCode: RIDER, fileName: "people.csv", csv }), 201).body;
  assert.equal(upload.readyCount, 2);
  assert.deepEqual(upload.rows.map((row: { status: string }) => row.status), ["READY", "READY", "DUPLICATE", "INVALID_PHONE", "INVALID_NAME"]);
  assert.equal(upload.rows[0].phoneLast4, one.slice(-4));
  assert.equal(upload.rows[0].entered, null, "valid numbers are not echoed in full");
  assert.equal(upload.seatsAvailable, 100);
  assert.equal((await as(adminB, "get", `/v1/admin/bulk-uploads/${upload.id}`)).status, 404);
  assert.equal((await as(viewerA, "post", `/v1/admin/bulk-uploads/${upload.id}/send`)).status, 403);

  const result = ok(await as(adminA, "post", `/v1/admin/bulk-uploads/${upload.id}/send`)).body;
  assert.equal(result.sent, 2);
  assert.equal((await as(adminA, "post", `/v1/admin/bulk-uploads/${upload.id}/send`)).status, 409, "an upload is sent once");
  assert.equal(sent.length, 2);
  assert.equal(sent[0].partnerName, "Pay a");
  const seats = await seatsOf(adminA);
  assert.equal(seats.available, 98);
  assert.equal(seats.reserved, 2);

  const token = sent[0].link.split("/v/")[1];
  assert.ok(sent[0].link.startsWith("https://l.test.liwip.example/v/"));
  const stored = await db.invite.findMany({ where: { tenantId: partnerA } });
  assert.ok(stored.every((invite) => invite.tokenHash !== token), "only a hash of the link is stored");
  const landing = await api().get(`/v/${token}`);
  assert.equal(landing.status, 302);
  assert.equal(landing.headers.location, `https://app.test.liwip.example/?invite=${token}`);
  assert.equal((await api().get("/v/not-a-real-token-at-all-xxxxx")).headers.location, "https://app.test.liwip.example/?invite=invalid");

  const again = ok(await as(adminA, "post", "/v1/admin/bulk-uploads").send({ programId: programA, packageCode: RIDER, fileName: "again.csv", csv: `name,mobile\nRavi Kumar,${one}\n` }), 201).body;
  assert.equal(again.rows[0].status, "ALREADY_INVITED");

  const invites = ok(await as(adminA, "get", "/v1/admin/invites")).body;
  assert.equal(invites.meta.total, 2);
  readyInvite = invites.items[0].id;
  ok(await as(adminA, "post", `/v1/admin/invites/${readyInvite}/cancel`));
  assert.equal((await seatsOf(adminA)).available, 99);
  assert.equal((await as(adminB, "post", `/v1/admin/invites/${invites.items[1].id}/cancel`)).status, 404);
});

test("Keystone refunds take seats back first; partners cannot refund", async () => {
  assert.equal((await as(adminA, "post", `/v1/admin/orders/${orderId}/refunds`).send({ amountPaise: 100, reason: "Not needed" })).status, 403);
  assert.equal((await as(keystone, "post", `/v1/admin/orders/${orderId}/refunds`).send({ amountPaise: 477_900, reason: "Ten seats back" })).status, 400, "a partner refund says how many seats");
  assert.equal((await as(keystone, "post", `/v1/admin/orders/${orderId}/refunds`).send({ amountPaise: 477_900, reason: "Too many", seats: { [RIDER]: 500 } })).status, 409);
  const refund = ok(await as(keystone, "post", `/v1/admin/orders/${orderId}/refunds`).send({ amountPaise: 477_900, reason: "Ten seats back", seats: { [RIDER]: 10 } })).body;
  assert.equal(refund.refundId, `${orderId}R1`);
  assert.deepEqual(refunds.at(-1), { orderId, refundId: `${orderId}R1`, amount: "4779.00" });
  assert.equal((await seatsOf(adminA)).available, 89);
  const order = ok(await as(keystone, "get", `/v1/admin/orders/${orderId}`, partnerA)).body;
  assert.equal(order.status, "PARTIALLY_REFUNDED");
  assert.equal(order.refundedPaise, 477_900);
  assert.equal((await as(keystone, "post", `/v1/admin/orders/${orderId}/refunds`).send({ amountPaise: 4_779_000, reason: "Everything", seats: { [RIDER]: 1 } })).status, 400, "never more than was paid");
});

test("seat adjustments need a reason and never go below zero; the ledger is audited", async () => {
  assert.equal((await as(adminA, "post", `/v1/admin/partners/${partnerA}/seats/adjust`).send({ packageCode: RIDER, delta: 5, reason: "Goodwill seats" })).status, 403);
  assert.equal((await as(keystone, "post", `/v1/admin/partners/${partnerA}/seats/adjust`).send({ packageCode: RIDER, delta: 5, reason: "" })).status, 400);
  assert.equal((await as(keystone, "post", `/v1/admin/partners/${partnerA}/seats/adjust`).send({ packageCode: RIDER, delta: -1000, reason: "Remove all of them" })).status, 409);
  ok(await as(keystone, "post", `/v1/admin/partners/${partnerA}/seats/adjust`).send({ packageCode: RIDER, delta: 5, reason: "Goodwill seats" }));
  assert.equal((await seatsOf(adminA)).available, 94);
  const ledger = await db.seatLedger.findMany({ where: { tenantId: partnerA, packageCode: RIDER }, orderBy: { createdAt: "asc" } });
  assert.deepEqual(ledger.map((row) => row.kind), ["PURCHASE", "RESERVE", "RESERVE", "RELEASE", "ADJUST", "ADJUST"]);
});

test("an individual's add-on check is paid upfront at its check price and covered on the case", async () => {
  const direct = await db.tenant.findUniqueOrThrow({ where: { slug: "liwip-direct" } });
  const program = await db.client.findFirstOrThrow({ where: { tenantId: direct.id, code: "INDIVIDUAL" } });
  const applicationId = `app_pay_${tag}_individual`;
  await db.application.create({ data: { id: applicationId, tenantId: direct.id, clientId: program.id, status: "DRAFT", workerPhone: `91${phone(40)}`, data: { personal: { phone: phone(40), nameAsAadhaar: "Solo Person", dateOfBirth: "1990-01-01" } } } });
  const buyer = { type: "INDIVIDUAL" as const, tenantId: direct.id, clientId: program.id, applicationId };
  await assert.rejects(app.get(QuoteService).create(buyer, [{ packageCode: RIDER, quantity: 1, addOns: [PAN] }]), "only the package's listed add-ons");
  const quote = await app.get(QuoteService).create(buyer, [{ packageCode: RIDER, quantity: 1, addOns: [COURT] }]);
  assert.equal(quote.subtotalPaise, 64_900, "list price 49,900 + court record 15,000");
  const order = await app.get(OrdersService).checkout(buyer, quote.id, `idem_${tag}_individual_1`, { id: applicationId, phone: phone(40) }, "https://app.test.liwip.example/?order={order_id}");
  gatewayOrders.get(order.orderId)!.order_status = "PAID";
  ok(await webhook(order.orderId));
  const covered = await db.prepaidCase.findUniqueOrThrow({ where: { applicationId } });
  assert.equal(covered.source, "ORDER");
  assert.deepEqual([...(covered.coveredChecks as string[])].sort(), [COURT, "DRIVING_LICENSE", PAN].sort());
  const [line] = await db.orderLine.findMany({ where: { orderId: order.orderId } });
  assert.equal(line.packagePaise, 49_900);
  assert.equal(line.addOnPaise, 15_000);
});

let lastMonthCase = "";
test("API usage: each billable check is charged once at the partner's price; covered, failed and unpriced checks are not", async () => {
  const at = new Date(periodRange(previousPeriod()).from.getTime() + 10 * 86_400_000);
  const make = async (suffix: string) => {
    const id = `app_pay_${tag}_${suffix}`;
    await db.application.create({ data: { id, tenantId: partnerA, clientId: programA, status: "VERIFICATION_IN_PROGRESS", workerPhone: `91${phone(50 + suffix.length)}`, data: { personal: { phone: "9000000000", nameAsAadhaar: "Api Person", dateOfBirth: "1990-01-01" } } } });
    return id;
  };
  const check = async (applicationId: string, suffix: string, type: string, status: string, call?: "SUCCESS" | "REJECTED") => {
    const id = `ver_pay_${tag}_${suffix}`;
    await db.verification.create({ data: { id, applicationId, tenantId: partnerA, clientId: programA, type, status, provider: call ? "surepass" : "manual", completedAt: at } });
    if (call) await db.providerCall.create({ data: { id: `pc_${tag}_${suffix}`, tenantId: partnerA, clientId: programA, applicationId, verificationId: id, operationKey: `op_${tag}_${suffix}`, provider: "surepass", operation: "pan", state: call, startedAt: at, completedAt: at } });
    return id;
  };
  lastMonthCase = await make("api");
  const billed = await check(lastMonthCase, "pan_ok", PAN, "VERIFIED", "SUCCESS");
  const noMatch = await check(lastMonthCase, "pan_nomatch", PAN, "FAILED", "SUCCESS");
  const rejected = await check(lastMonthCase, "pan_rejected", PAN, "FAILED", "REJECTED");
  const field = await check(lastMonthCase, "field", FIELD, "VERIFIED");
  const seatCase = await make("seat");
  const covered = await check(seatCase, "pan_covered", PAN, "VERIFIED", "SUCCESS");
  await db.prepaidCase.create({ data: { applicationId: seatCase, tenantId: partnerA, source: "SEAT", packageCode: RIDER, packageVersion: 1, coveredChecks: [PAN] } });

  assert.equal((await as(adminA, "post", "/v1/admin/usage-charges/rate")).status, 403);
  ok(await as(keystone, "post", "/v1/admin/usage-charges/rate"));
  ok(await as(keystone, "post", "/v1/admin/usage-charges/rate"));
  const charges = await db.usageCharge.findMany({ where: { verificationId: { in: [billed, noMatch, rejected, field, covered] } } });
  assert.deepEqual(charges.map((charge) => charge.verificationId).sort(), [billed, noMatch].sort(), "a no-match result is billable work; rejected, unpriced and covered checks are not");
  assert.ok(charges.every((charge) => charge.unitPricePaise === 400), "the partner's own price");

  // Once a price exists, the waiting check is charged.
  const revenueBefore = ok(await as(keystone, "get", `/v1/admin/revenue?partnerId=${partnerA}&from=${previousPeriod()}-01`)).body;
  assert.ok(revenueBefore.checks.unratedByCheckType[FIELD] >= 1);
  ok(await as(keystone, "post", "/v1/admin/check-rates").send({ checkType: FIELD, unitPricePaise: 25_000 }), 201);
  ok(await as(keystone, "post", "/v1/admin/usage-charges/rate"));
  assert.equal((await db.usageCharge.findUniqueOrThrow({ where: { verificationId: field } })).unitPricePaise, 25_000);
});

test("monthly statement: one per partner, invoiced, never twice; finance records payment", async () => {
  const period = previousPeriod();
  assert.equal((await as(adminA, "post", "/v1/admin/statements/issue").send({ period })).status, 403);
  const current = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 7);
  assert.equal((await as(keystone, "post", "/v1/admin/statements/issue").send({ period: current, partnerId: partnerA })).status, 400, "a month is billed after it ends");
  const issued = ok(await as(keystone, "post", "/v1/admin/statements/issue").send({ period, partnerId: partnerA })).body;
  assert.equal(issued.issued, 1);
  assert.equal(ok(await as(keystone, "post", "/v1/admin/statements/issue").send({ period, partnerId: partnerA })).body.issued, 0, "issuing again changes nothing");

  const list = ok(await as(adminA, "get", "/v1/admin/statements")).body;
  assert.equal(list.items.length, 1);
  const statement = list.items[0];
  assert.equal(statement.period, period);
  assert.deepEqual(statement.lines, [{ checkType: FIELD, count: 1, unitPricePaise: 25_000, amountPaise: 25_000 }, { checkType: PAN, count: 2, unitPricePaise: 400, amountPaise: 800 }]);
  assert.equal(statement.taxablePaise, 25_800);
  assert.equal(statement.cgstPaise + statement.sgstPaise, 4_644);
  assert.equal(statement.totalPaise, 30_444);
  assert.match(statement.invoice.number, /^LBV\/\d{4}-\d{2}\/\d{5}$/);
  assert.equal(statement.status, "ISSUED");
  assert.equal(ok(await as(adminB, "get", "/v1/admin/statements")).body.items.length, 0, "partners see only their own");
  assert.equal((await as(adminB, "get", `/v1/admin/statements/${statement.id}`)).status, 404);

  assert.equal((await as(keystone, "post", `/v1/admin/statements/${statement.id}/paid`).send({ reference: "x" })).status, 400);
  const paid = ok(await as(keystone, "post", `/v1/admin/statements/${statement.id}/paid`).send({ reference: "NEFT UTR 1234567890" })).body;
  assert.equal(paid.status, "PAID");
  assert.equal((await as(keystone, "post", `/v1/admin/statements/${statement.id}/paid`).send({ reference: "NEFT UTR 1234567890" })).status, 409);
});

test("revenue keeps packages and checks apart, net of GST and refunds", async () => {
  const from = `${previousPeriod()}-01`;
  const report = ok(await as(keystone, "get", `/v1/admin/revenue?partnerId=${partnerA}&from=${from}`)).body;
  assert.equal(report.packages.salesPaise, 4_050_000);
  assert.equal(report.packages.refundsPaise, 405_000, "the 4,779.00 refund less its GST, taken from the package sale");
  assert.equal(report.packages.netPaise, 3_645_000);
  assert.equal(report.packages.seatsSold, 100);
  assert.equal(report.checks.addOnsPaise, 0);
  assert.equal(report.checks.apiUsagePaise, 25_800);
  assert.equal(report.checks.apiInvoicedPaise, 25_800);
  assert.equal(report.checks.netPaise, 25_800);
  assert.equal(report.totals.netPaise, 3_645_000 + 25_800);
  assert.equal(report.byPackage[0].packageCode, RIDER);
  assert.deepEqual(report.byCheckType.map((row: { checkType: string }) => row.checkType).sort(), [FIELD, PAN].sort());
  assert.equal(report.byPartner.length, 1);
  assert.equal(report.byMonth.find((row: { period: string }) => row.period === previousPeriod()).apiUsagePaise, 25_800);

  const everyone = ok(await as(keystone, "get", `/v1/admin/revenue?from=${from}`)).body;
  assert.ok(everyone.checks.addOnsPaise >= 15_000, "the individual's add-on is a check sale");
  assert.ok(everyone.packages.individualPackages >= 1);
  assert.equal((await as(keystone, "get", "/v1/admin/revenue?from=2026-13-01")).status, 400);
});

test("invite redemption: only the invited number, through the worker app, opens the case under the partner and uses the seat", async () => {
  // The Liwip worker app's own key (worker:cases is Keystone-only) and a person signed in through it.
  const app = await new PartnerProvisioning(db).createPartner({ tenantSlug: `liwip-app-${tag.toLowerCase()}`, tenantName: "Liwip app", clientCode: "WORKER_PORTAL", clientName: "Liwip worker app", scopes: ["worker:cases", "otp:write"] });
  const appKey = app.rawKey;
  const signedIn = (mobile: string) => issueWorkerToken({ tenantId: app.tenant.id, clientId: app.client.id, phone: `91${mobile}` }).token;

  const invitee = phone(70);
  const upload = ok(await as(adminA, "post", "/v1/admin/bulk-uploads").send({ programId: programA, packageCode: RIDER, fileName: "one.csv", csv: `name,mobile\nSita Devi,${invitee}\n` }), 201).body;
  ok(await as(adminA, "post", `/v1/admin/bulk-uploads/${upload.id}/send`));
  const token = sent.at(-1)!.link.split("/v/")[1];
  const before = await seatsOf(adminA);

  // Before sign-in: whose link it is. Only the worker app's key may ask.
  const preview = ok(await api().get(`/v1/worker/invites/${token}`).set("x-api-key", appKey)).body;
  assert.deepEqual(preview, { status: "OPEN", partnerName: "Pay a", packageName: "Rider", phoneLast4: invitee.slice(-4) });
  assert.equal((await api().get("/v1/worker/invites/not-a-real-token-at-all-xxxxx").set("x-api-key", appKey)).body.status, "INVALID");

  const redeem = (who: string) => api().post(`/v1/worker/invites/${token}/redeem`).set("x-api-key", appKey).set("x-worker-token", signedIn(who));
  const wrong = await redeem(phone(71));
  assert.equal(wrong.status, 403, "another number cannot use the link");
  assert.match(wrong.body.message, new RegExp(invitee.slice(-4)));

  const redeemed = ok(await redeem(invitee)).body;
  assert.equal(redeemed.partnerName, "Pay a");
  assert.equal(ok(await redeem(invitee)).body.applicationId, redeemed.applicationId, "redeeming again returns the same case");

  // The case belongs to the partner's program, with the package's checks, paid by the seat.
  const caseView = ok(await api().get("/v1/worker/case").set("x-api-key", appKey).set("x-worker-token", redeemed.workerToken)).body;
  assert.equal(caseView.applicationId, redeemed.applicationId);
  assert.deepEqual(caseView.sponsor, { partnerName: "Pay a", packageName: "Rider" });
  assert.equal(caseView.checksFixed, true);
  // Rider here is PAN_<tag> + DRIVING_LICENSE; the app has no step for the tagged test type, Aadhaar always leads.
  assert.deepEqual(caseView.selectedChecks, ["AADHAAR", "DRIVING_LICENSE"]);
  assert.equal((await api().put("/v1/worker/case/checks").set("x-api-key", appKey).set("x-worker-token", redeemed.workerToken).send({ checks: ["PAN"] })).status, 409, "the company chose the checks");
  const row = await db.application.findUniqueOrThrow({ where: { id: redeemed.applicationId } });
  assert.equal(row.tenantId, partnerA);
  assert.equal(row.clientId, programA);
  assert.equal(row.apiKeyId, null, "the worker app's key does not own a partner's case");
  assert.deepEqual((await db.prepaidCase.findUniqueOrThrow({ where: { applicationId: row.id } })).coveredChecks, [PAN, "DRIVING_LICENSE", "AADHAAR"], "the seat also covers the Aadhaar the journey adds");
  const after = await seatsOf(adminA);
  assert.equal(after.used, before.used + 1);
  assert.equal(after.reserved, before.reserved - 1);
  assert.equal(after.available, before.available, "the seat was already set aside when the link was sent");

  // The partner sees the case; an invite token is useless with any other key.
  assert.ok((await as(adminA, "get", "/v1/admin/cases")).body.items.some((item: { id: string }) => item.id === row.id));
  assert.equal((await api().get("/v1/worker/case").set("x-api-key", app.rawKey).set("x-worker-token", signedIn(invitee))).body.applicationId === row.id, false, "the app's own sign-in is a different (Liwip) case");
});
