import "reflect-metadata";
import assert from "node:assert/strict";
import { test } from "node:test";
import { cashfreeSignature, CashfreeGateway } from "../../apps/verification-api/src/modules/billing/cashfree.client";
import { packageCode } from "../../apps/verification-api/src/modules/billing/catalog.service";
import { normalisePhone, parseCsv } from "../../apps/verification-api/src/modules/billing/invites.service";
import { newOrderCode, ORDER_CODE, refundId } from "../../apps/verification-api/src/modules/billing/order-code";
import { DiscountTier, priceOrder, rupees, tierFor } from "../../apps/verification-api/src/modules/billing/pricing";
import { financialYear, periodOf, periodRange, previousPeriod } from "../../apps/verification-api/src/modules/billing/billing-config";
import { checkType, pickRate } from "../../apps/verification-api/src/modules/billing/check-rates.service";
import { AiSensyInviteSender, inviteSenderFromEnv, LogInviteSender } from "../../apps/verification-api/src/modules/billing/invite-sender";

const rider = { id: "p1", code: "RIDER", version: 2, name: "Rider", listPricePaise: 49_900 };
const crime = { checkType: "ECOURTS_SEARCH", checkRateId: "r1", unitPricePaise: 15_000 };
const tier = (over: Partial<DiscountTier>): DiscountTier => ({ id: "t", scope: "GLOBAL", packageCode: null, minQty: 1, maxQty: null, percentOffBps: 0, ...over });
const karnataka = { rateBps: 1800, sellerState: "Karnataka", buyerState: "Karnataka" };

test("order codes are 10 characters without look-alikes", () => {
  const codes = new Set(Array.from({ length: 2000 }, newOrderCode));
  assert.equal(codes.size, 2000);
  for (const code of codes) assert.match(code, ORDER_CODE);
  assert.doesNotMatch("K7QM4XT9P0", ORDER_CODE);
  assert.doesNotMatch("K7QM4XT9PI", ORDER_CODE);
  assert.doesNotMatch("k7qm4xt9pb", ORDER_CODE);
  assert.equal(refundId("K7QM4XT9PB", 2), "K7QM4XT9PBR2");
});

test("partner tiers beat global ones; within a scope the largest discount wins", () => {
  const tiers = [
    tier({ id: "g10", minQty: 50, percentOffBps: 1000 }),
    tier({ id: "g15", minQty: 100, percentOffBps: 1500 }),
    tier({ id: "p5", scope: "PARTNER", packageCode: "RIDER", minQty: 100, percentOffBps: 500 }),
    tier({ id: "g20other", packageCode: "DRIVER", minQty: 1, percentOffBps: 2000 })
  ];
  assert.equal(tierFor(tiers, "RIDER", 10), null);
  assert.equal(tierFor(tiers, "RIDER", 60)?.id, "g10");
  assert.equal(tierFor(tiers, "RIDER", 100)?.id, "p5");
  assert.equal(tierFor(tiers, "CUSTOMER_REP", 100)?.id, "g15");
  assert.equal(tierFor([tier({ id: "capped", minQty: 10, maxQty: 49, percentOffBps: 500 })], "RIDER", 50), null);
});

test("pricing: the bulk tier discounts the package only; add-on checks keep their check price", () => {
  const order = priceOrder([{ item: rider, quantity: 100, addOns: [crime], partnerUnitPaise: 45_000 }], [tier({ id: "g10", minQty: 50, percentOffBps: 1000 })], karnataka);
  const [line] = order.lines;
  assert.equal(line.unitPricePaise, 45_000);
  assert.equal(line.grossPaise, 6_000_000);
  assert.equal(line.discountPaise, 450_000, "10% of the package part only");
  assert.equal(line.packagePaise, 4_050_000);
  assert.equal(line.addOnPaise, 1_500_000);
  assert.equal(line.lineTotalPaise, line.packagePaise + line.addOnPaise);
  assert.equal(order.packagePaise, 4_050_000);
  assert.equal(order.addOnPaise, 1_500_000);
  assert.equal(order.taxablePaise, 5_550_000);
  assert.equal(order.cgstPaise + order.sgstPaise, 999_000);
  assert.equal(order.igstPaise, 0);
  assert.equal(order.totalPaise, 6_549_000);
  assert.equal(rupees(order.totalPaise), "65490.00");

  const individual = priceOrder([{ item: rider, quantity: 1, addOns: [crime] }], [], { ...karnataka, buyerState: null });
  assert.equal(individual.packagePaise, 49_900);
  assert.equal(individual.addOnPaise, 15_000);
  assert.deepEqual(individual.lines[0].addOns, [crime]);

  const inter = priceOrder([{ item: rider, quantity: 1, addOns: [] }], [], { ...karnataka, buyerState: " maharashtra " });
  assert.equal(inter.igstPaise, 8_982);
  assert.equal(inter.cgstPaise + inter.sgstPaise, 0);
  const sameState = priceOrder([{ item: rider, quantity: 1, addOns: [] }], [], { ...karnataka, buyerState: "  KARNATAKA" });
  assert.equal(sameState.igstPaise, 0);
  // GST of 901 paise splits 450 CGST + 451 SGST, so nothing is lost to rounding.
  const odd = priceOrder([{ item: { ...rider, listPricePaise: 5_003 }, quantity: 1, addOns: [] }], [], { ...karnataka, buyerState: null });
  assert.equal(odd.cgstPaise, 450);
  assert.equal(odd.sgstPaise, 451);
  assert.equal(odd.totalPaise, 5_003 + 901);
  assert.throws(() => priceOrder([], [], karnataka));
  assert.throws(() => priceOrder([{ item: rider, quantity: 0, addOns: [] }], [], karnataka));
  assert.throws(() => priceOrder([{ item: rider, quantity: 1.5, addOns: [] }], [], karnataka));
});

test("package codes are uppercase identifiers, case-insensitive on input", () => {
  assert.equal(packageCode("RIDER"), "RIDER");
  assert.equal(packageCode("HOME_SERVICES_PRO"), "HOME_SERVICES_PRO");
  assert.equal(packageCode(" rider "), "RIDER");
  for (const bad of ["R", "1RIDER", "RIDER-X", "", undefined]) assert.throws(() => packageCode(bad));
});

test("phones normalise to 91 plus ten digits", () => {
  assert.equal(normalisePhone("98450 12345"), "919845012345");
  assert.equal(normalisePhone("+91-98450-12345"), "919845012345");
  assert.equal(normalisePhone("09845012345"), "919845012345");
  for (const bad of ["12345", "5845012345", "", null, "919845012345678"]) assert.equal(normalisePhone(bad), null);
});

test("CSV needs name and mobile columns and handles quotes", () => {
  const rows = parseCsv('Name,Mobile\r\n"Kumar, Ravi",9845012345\nAsha "A" Rao,"+91 98450 54321"\n\n');
  assert.deepEqual(rows, [{ name: "Kumar, Ravi", mobile: "9845012345" }, { name: 'Asha "A" Rao', mobile: "+91 98450 54321" }]);
  assert.deepEqual(parseCsv("phone,full name\n9845012345,Ravi")[0], { name: "Ravi", mobile: "9845012345" });
  assert.throws(() => parseCsv("email,mobile\nx@y.z,9845012345"));
});

test("webhook signatures are checked against the raw body", () => {
  const previous = process.env.CASHFREE_SECRET_KEY;
  process.env.CASHFREE_SECRET_KEY = "test-secret";
  try {
    const body = Buffer.from('{"type":"PAYMENT_SUCCESS_WEBHOOK","data":{"order":{"order_id":"K7QM4XT9PB"}}}');
    const signature = cashfreeSignature(body, "1729500000", "test-secret");
    const gateway = new CashfreeGateway();
    assert.equal(gateway.verifyWebhook(body, "1729500000", signature), true);
    assert.equal(gateway.verifyWebhook(Buffer.from(body.toString().replace("K7", "K8")), "1729500000", signature), false);
    assert.equal(gateway.verifyWebhook(body, "1729500001", signature), false);
    assert.equal(gateway.verifyWebhook(body, "1729500000", ""), false);
  } finally {
    if (previous === undefined) delete process.env.CASHFREE_SECRET_KEY; else process.env.CASHFREE_SECRET_KEY = previous;
  }
});

test("financial years and billing months run on India time, whatever the server's timezone", () => {
  assert.equal(financialYear(new Date("2026-03-31T23:59:00+05:30")), "2025-26");
  assert.equal(financialYear(new Date("2026-04-01T00:30:00+05:30")), "2026-27", "already April in India, still March in UTC");
  assert.equal(periodOf(new Date("2026-10-31T23:00:00+05:30")), "2026-10");
  assert.equal(periodOf(new Date("2026-11-01T00:10:00+05:30")), "2026-11");
  const october = periodRange("2026-10");
  assert.equal(october.from.toISOString(), "2026-09-30T18:30:00.000Z");
  assert.equal(october.to.toISOString(), "2026-10-31T18:30:00.000Z");
  assert.equal(periodRange("2026-12").to.toISOString(), "2026-12-31T18:30:00.000Z");
  assert.equal(previousPeriod(new Date("2026-11-01T00:10:00+05:30")), "2026-10");
  assert.equal(previousPeriod(new Date("2027-01-15T12:00:00+05:30")), "2026-12");
  assert.throws(() => periodRange("2026-13"));
});

test("a partner's own check price beats the list price; the newest price in force wins", () => {
  const at = new Date("2026-10-15T00:00:00Z");
  const row = (over: Record<string, unknown>) => ({ id: "x", tenantId: null, checkType: "PAN", unitPricePaise: 500, validFrom: null, validTo: null, isActive: true, createdAt: new Date("2026-01-01"), ...over }) as Parameters<typeof pickRate>[0][number];
  const rows = [
    row({ id: "list-old", unitPricePaise: 500 }),
    row({ id: "list-new", unitPricePaise: 600, validFrom: new Date("2026-10-01") }),
    row({ id: "list-future", unitPricePaise: 900, validFrom: new Date("2026-11-01") }),
    row({ id: "own-ended", tenantId: "t1", unitPricePaise: 300, validTo: new Date("2026-10-10") }),
    row({ id: "own-off", tenantId: "t2", unitPricePaise: 200, isActive: false }),
    row({ id: "dl", checkType: "DRIVING_LICENSE", unitPricePaise: 1500 })
  ];
  assert.equal(pickRate(rows, null, "PAN", at)?.id, "list-new");
  assert.equal(pickRate(rows, "t1", "PAN", new Date("2026-10-05"))?.id, "own-ended");
  assert.equal(pickRate(rows, "t1", "PAN", at)?.id, "list-new", "an ended partner price falls back to the list");
  assert.equal(pickRate(rows, "t2", "PAN", at)?.id, "list-new", "a switched-off partner price is ignored");
  assert.equal(pickRate(rows, null, "PAN", new Date("2026-11-02"))?.id, "list-future");
  assert.equal(pickRate(rows, null, "PASSPORT", at), null);
  assert.equal(checkType(" pan "), "PAN");
  assert.throws(() => checkType("P"));
});

test("AiSensy invites: name and company as template params, the token as the URL button, no key in errors", async () => {
  const realFetch = globalThis.fetch;
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  let reply: { status: number; body: unknown } = { status: 200, body: { success: true, submitted_message_id: "m-1" } };
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  }) as typeof fetch;
  try {
    const sender = new AiSensyInviteSender({ apiKey: "secret-key", campaignName: "liwip_bgv_invite", endpoint: "https://aisensy.test/campaign", source: "Liwip_BGV_Invites" });
    const message = { phone: "919845012345", name: "Ravi Kumar", partnerName: "Zomato", link: "https://liwip.in/v/tok_123", token: "tok_123" };
    assert.deepEqual(await sender.send(message), { channel: "WHATSAPP", messageId: "m-1", status: "SENT" });
    assert.equal(calls[0].url, "https://aisensy.test/campaign");
    assert.equal(calls[0].body.destination, "919845012345");
    assert.deepEqual(calls[0].body.templateParams, ["Ravi Kumar", "Zomato"]);
    assert.deepEqual(calls[0].body.buttons, [{ type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: "tok_123" }] }]);
    reply = { status: 200, body: { success: false, message: "campaign not live" } };
    await assert.rejects(sender.send(message), (error: Error) => !error.message.includes("secret-key") && error.message.includes("campaign not live"));
    reply = { status: 401, body: { message: "bad key" } };
    await assert.rejects(sender.send(message), /401/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("invites go by WhatsApp only when INVITE_SENDER=aisensy is fully configured", async () => {
  const saved = { ...process.env };
  try {
    delete process.env.INVITE_SENDER;
    assert.ok(inviteSenderFromEnv() instanceof LogInviteSender);
    process.env.NODE_ENV = "production";
    await assert.rejects(inviteSenderFromEnv().send({ phone: "919845012345", name: "A", partnerName: "B", link: "l", token: "t" }), /no WhatsApp sender/);
    process.env.INVITE_SENDER = "log";
    assert.equal((await inviteSenderFromEnv().send({ phone: "919845012345", name: "A", partnerName: "B", link: "l", token: "t" })).channel, "LOG", "staging can choose the stand-in");
    process.env.INVITE_SENDER = "aisensy";
    delete process.env.AISENSY_API_KEY; delete process.env.AISENSY_INVITE_CAMPAIGN_NAME;
    assert.throws(() => inviteSenderFromEnv(), /AISENSY_API_KEY/);
    process.env.AISENSY_API_KEY = "k"; process.env.AISENSY_INVITE_CAMPAIGN_NAME = "liwip_bgv_invite";
    assert.ok(inviteSenderFromEnv() instanceof AiSensyInviteSender);
  } finally {
    process.env = saved;
  }
});
