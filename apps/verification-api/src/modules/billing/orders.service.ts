import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { AuditService } from "../../common/audit/audit.service";
import { PrismaService } from "../../common/database/prisma.service";
import { billingConfig } from "./billing-config";
import { checkTypesOf } from "./catalog.service";
import { issueInvoice } from "./invoices";
import { CashfreeError, PAYMENT_GATEWAY, PaymentGateway } from "./cashfree.client";
import { newOrderCode, ORDER_CODE, refundId } from "./order-code";
import type { AddOnItem, PricedLine } from "./pricing";
import { rupees } from "./pricing";
import type { Buyer } from "./quote.service";
import { SeatsService } from "./seats.service";

type OrderRow = Prisma.OrderGetPayload<{ include: { lines: true; payments: true; refunds: true; invoice: true } }>;

export interface CheckoutCustomer { id: string; phone: string; name?: string; email?: string }

const KEY = /^[A-Za-z0-9_-]{16,128}$/;
const FINAL = new Set(["PAID", "FAILED", "EXPIRED", "REFUNDED", "PARTIALLY_REFUNDED"]);

/** Cashfree customer_id: 3 to 50 letters and digits. */
const customerId = (value: string) => value.replace(/[^A-Za-z0-9]/g, "").slice(-50).padStart(3, "0");

@Injectable()
export class OrdersService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OrdersService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
    @Inject(SeatsService) private readonly seats: SeatsService,
    @Inject(AuditService) private readonly audit: AuditService
  ) {}

  onModuleInit() {
    if (process.env.BILLING_JOBS === "off") return;
    this.timer = setInterval(() => void this.reconcile().catch((error) => this.logger.warn(`Reconcile failed: ${(error as Error).message}`)), 10 * 60_000);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * Creates the order for a quote and its Cashfree order. Repeating the same Idempotency-Key
   * returns the same order; a quote can back only one order.
   */
  async checkout(buyer: Buyer, quoteIdValue: unknown, idempotencyKey: string | undefined, customer: CheckoutCustomer, returnUrl: string) {
    if (!KEY.test(idempotencyKey ?? "")) throw new BadRequestException("Idempotency-Key must be 16 to 128 letters, digits, _ or -");
    const quoteId = String(quoteIdValue ?? "");
    const existing = await this.prisma.order.findFirst({ where: { tenantId: buyer.tenantId, OR: [{ idempotencyKey }, { quoteId }] }, include: { lines: true } });
    if (existing) {
      if (existing.quoteId !== quoteId || existing.idempotencyKey !== idempotencyKey) throw new ConflictException("This quote or Idempotency-Key was already used for another order");
      return this.ensureCashfreeOrder(existing, customer, returnUrl);
    }
    const quote = await this.prisma.quote.findFirst({ where: { id: quoteId, tenantId: buyer.tenantId, buyerType: buyer.type, ...(buyer.applicationId ? { applicationId: buyer.applicationId } : {}) } });
    if (!quote) throw new NotFoundException("Quote not found");
    if (quote.expiresAt < new Date()) throw new ConflictException("This quote has expired. Get a new price.");

    const lines = quote.lines as unknown as PricedLine[];
    const expiresAt = new Date(Date.now() + billingConfig().orderMinutes * 60_000);
    let order: Prisma.OrderGetPayload<{ include: { lines: true } }> | null = null;
    for (let attempt = 0; attempt < 5 && !order; attempt++) {
      const code = newOrderCode();
      try {
        order = await this.prisma.order.create({
          data: {
            id: code, quoteId: quote.id, buyerType: quote.buyerType, tenantId: quote.tenantId, clientId: quote.clientId, applicationId: quote.applicationId,
            createdById: buyer.createdById ?? null, subtotalPaise: quote.subtotalPaise, discountPaise: quote.discountPaise, taxablePaise: quote.taxablePaise,
            cgstPaise: quote.cgstPaise, sgstPaise: quote.sgstPaise, igstPaise: quote.igstPaise, totalPaise: quote.totalPaise, idempotencyKey: idempotencyKey!, expiresAt,
            lines: {
              create: lines.map((line) => ({
                id: `oline_${randomUUID()}`, tenantId: quote.tenantId, packageId: line.packageId, packageCode: line.packageCode, packageVersion: line.packageVersion,
                quantity: line.quantity, unitListPaise: line.unitListPaise, unitPricePaise: line.unitPricePaise, addOns: line.addOns as unknown as Prisma.InputJsonValue,
                discountRuleId: line.discountRuleId, discountBps: line.discountBps, discountPaise: line.discountPaise, packagePaise: line.packagePaise, addOnPaise: line.addOnPaise, lineTotalPaise: line.lineTotalPaise
              }))
            }
          },
          include: { lines: true }
        });
      } catch (error) {
        const prismaError = error as Prisma.PrismaClientKnownRequestError;
        if (prismaError.code !== "P2002") throw error;
        const target = String(prismaError.meta?.target ?? "");
        // Only a clash on the random order code is retried; a reused quote or key is the caller's.
        if (!target.includes("id") || target.includes("quoteId") || target.includes("idempotencyKey")) throw new ConflictException("This quote or Idempotency-Key was already used");
      }
    }
    if (!order) throw new ConflictException("Could not allocate an order code. Try again.");
    this.audit.record({ actorType: buyer.type === "PARTNER" ? "STAFF" : "PARTNER", actorUserId: buyer.createdById ?? null, action: "orders.create", outcome: "SUCCESS", tenantId: order.tenantId, clientId: order.clientId, resourceType: "Order", resourceId: order.id, metadata: { totalPaise: order.totalPaise } });
    return this.ensureCashfreeOrder(order, customer, returnUrl);
  }

  /** Creates (or re-reads) the Cashfree order and returns what the checkout needs. */
  private async ensureCashfreeOrder(order: { id: string; status: string; totalPaise: number; expiresAt: Date; paymentSessionId: string | null }, customer: CheckoutCustomer, returnUrl: string) {
    if (order.status !== "PENDING_PAYMENT") return this.checkoutView(order);
    if (order.expiresAt < new Date()) throw new ConflictException("This order has expired. Get a new price.");
    if (order.paymentSessionId) return this.checkoutView(order);
    let created;
    try {
      created = await this.gateway.createOrder({
        orderId: order.id, amount: rupees(order.totalPaise), customer: { ...customer, id: customerId(customer.id) },
        returnUrl: returnUrl.replace("{order_id}", order.id), notifyUrl: process.env.CASHFREE_NOTIFY_URL || undefined, expiresAt: order.expiresAt, note: "Liwip BGV verifications"
      });
    } catch (error) {
      // A retry after a lost response: the order already exists at Cashfree.
      if (error instanceof CashfreeError && (error.status === 409 || /exist/i.test(error.message))) created = await this.gateway.getOrder(order.id);
      else throw error;
    }
    const updated = await this.prisma.order.update({ where: { id: order.id }, data: { cfOrderId: created.cf_order_id === undefined ? null : String(created.cf_order_id), paymentSessionId: created.payment_session_id ?? null } });
    return this.checkoutView(updated);
  }

  private checkoutView(order: { id: string; status: string; totalPaise: number; expiresAt: Date; paymentSessionId: string | null }) {
    return { orderId: order.id, status: order.status, totalPaise: order.totalPaise, expiresAt: order.expiresAt, paymentSessionId: order.status === "PENDING_PAYMENT" ? order.paymentSessionId : null, mode: this.gateway.mode };
  }

  /** One order as its buyer or Keystone sees it. A pending order is checked with Cashfree first. */
  async get(orderId: string, where: Prisma.OrderWhereInput) {
    if (!ORDER_CODE.test(orderId)) throw new NotFoundException("Order not found");
    const found = await this.prisma.order.findFirst({ where: { ...where, id: orderId }, select: { id: true, status: true, updatedAt: true } });
    if (!found) throw new NotFoundException("Order not found");
    if (found.status === "PENDING_PAYMENT" && Date.now() - found.updatedAt.getTime() > 3_000) await this.confirm(orderId).catch(() => undefined);
    return orderView((await this.prisma.order.findUnique({ where: { id: orderId }, include: { lines: true, payments: true, refunds: true, invoice: true } }))!);
  }

  async list(where: Prisma.OrderWhereInput, page: { skip: number; limit: number }) {
    const [rows, total] = await Promise.all([
      this.prisma.order.findMany({ where, orderBy: { createdAt: "desc" }, skip: page.skip, take: page.limit, include: { lines: true, payments: true, refunds: true, invoice: true } }),
      this.prisma.order.count({ where })
    ]);
    return { rows: rows.map(orderView), total };
  }

  /** Asks Cashfree for the order's state and applies it. Safe to call any number of times. */
  async confirm(orderId: string) {
    const remote = await this.gateway.getOrder(orderId);
    if (remote.order_status === "PAID") return this.markPaid(orderId);
    if (remote.order_status === "EXPIRED" || remote.order_status === "TERMINATED") {
      await this.prisma.order.updateMany({ where: { id: orderId, status: "PENDING_PAYMENT" }, data: { status: "EXPIRED" } });
    }
    return false;
  }

  /**
   * Paid once: the status flip is the guard, so a webhook and a poll racing each other
   * credit seats only once. Payment, invoice and seats (or the individual's purchase) land together.
   */
  async markPaid(orderId: string) {
    const payments = await this.gateway.getPayments(orderId).catch(() => []);
    const paid = payments.find((payment) => payment.payment_status === "SUCCESS");
    const done = await this.prisma.$transaction(async (tx) => {
      const flipped = await tx.order.updateMany({ where: { id: orderId, status: "PENDING_PAYMENT" }, data: { status: "PAID", paidAt: new Date() } });
      if (!flipped.count) return false;
      const order = await tx.order.findUniqueOrThrow({ where: { id: orderId }, include: { lines: true } });
      await tx.payment.create({
        data: {
          id: `payment_${randomUUID()}`, orderId, tenantId: order.tenantId, provider: "CASHFREE", cfPaymentId: paid?.cf_payment_id === undefined ? null : String(paid.cf_payment_id),
          status: "SUCCESS", amountPaise: paid?.payment_amount === undefined ? order.totalPaise : Math.round(paid.payment_amount * 100), method: paid?.payment_group ?? null
        }
      });
      await issueInvoice(tx, { orderId: order.id, tenantId: order.tenantId, individual: order.buyerType !== "PARTNER", taxablePaise: order.taxablePaise, cgstPaise: order.cgstPaise, sgstPaise: order.sgstPaise, igstPaise: order.igstPaise, totalPaise: order.totalPaise });
      if (order.buyerType === "PARTNER") {
        for (const line of order.lines) await this.seats.purchase(tx, line);
      } else if (order.applicationId) {
        const application = await tx.application.findUnique({ where: { id: order.applicationId }, select: { data: true } });
        const line = order.lines[0];
        const data = (application?.data ?? {}) as Record<string, unknown>;
        await tx.application.update({
          where: { id: order.applicationId },
          data: { packageId: line.packageId, data: { ...data, purchase: { orderId, packageCode: line.packageCode, packageVersion: line.packageVersion, addOns: line.addOns, paidAt: new Date().toISOString() } } as Prisma.InputJsonValue }
        });
        // The package's checks and the paid add-ons are covered: never billed again as usage.
        const pkg = await tx.verificationPackage.findUniqueOrThrow({ where: { id: line.packageId }, select: { checks: true } });
        const covered = [...new Set([...checkTypesOf(pkg.checks), ...(line.addOns as unknown as AddOnItem[]).map((addOn) => addOn.checkType)])];
        await tx.prepaidCase.upsert({
          where: { applicationId: order.applicationId },
          create: { applicationId: order.applicationId, tenantId: order.tenantId, source: "ORDER", orderId, packageCode: line.packageCode, packageVersion: line.packageVersion, coveredChecks: covered },
          update: { source: "ORDER", orderId, packageCode: line.packageCode, packageVersion: line.packageVersion, coveredChecks: covered }
        });
      }
      return true;
    });
    if (done) this.audit.record({ actorType: "SYSTEM", action: "orders.paid", outcome: "SUCCESS", resourceType: "Order", resourceId: orderId });
    return done;
  }

  /** Cashfree webhook: verify the signature, drop duplicates, then confirm with Cashfree itself. */
  async handleWebhook(rawBody: Buffer | undefined, headers: Record<string, string | string[] | undefined>) {
    const header = (name: string) => { const value = headers[name]; return Array.isArray(value) ? value[0] : value; };
    if (!rawBody?.length) throw new BadRequestException("Empty body");
    const valid = this.gateway.verifyWebhook(rawBody, header("x-webhook-timestamp") ?? "", header("x-webhook-signature") ?? "");
    let payload: { type?: string; data?: { order?: { order_id?: string } } } = {};
    try { payload = JSON.parse(rawBody.toString("utf8")); } catch { /* recorded below as unreadable */ }
    const orderId = payload.data?.order?.order_id;
    const key = header("x-idempotency-key") || `${header("x-webhook-timestamp")}:${header("x-webhook-signature")}`;
    try {
      await this.prisma.paymentWebhookEvent.create({ data: { id: `pwh_${randomUUID()}`, provider: "CASHFREE", idempotencyKey: key.slice(0, 200), type: String(payload.type ?? "UNKNOWN").slice(0, 60), orderId: orderId && ORDER_CODE.test(orderId) ? orderId : null, signatureValid: valid } });
    } catch (error) {
      if ((error as Prisma.PrismaClientKnownRequestError).code === "P2002") return { received: true, duplicate: true };
      throw error;
    }
    if (!valid) throw new BadRequestException("Invalid signature");
    if (orderId && ORDER_CODE.test(orderId) && payload.type === "PAYMENT_SUCCESS_WEBHOOK") await this.confirm(orderId);
    await this.prisma.paymentWebhookEvent.updateMany({ where: { provider: "CASHFREE", idempotencyKey: key.slice(0, 200) }, data: { processedAt: new Date() } });
    return { received: true };
  }

  /** Every 10 minutes: settle pending orders with Cashfree and expire the stale ones. */
  async reconcile() {
    const pending = await this.prisma.order.findMany({ where: { status: "PENDING_PAYMENT", createdAt: { lt: new Date(Date.now() - 2 * 60_000) } }, select: { id: true, expiresAt: true, paymentSessionId: true }, take: 200 });
    for (const order of pending) {
      if (!order.paymentSessionId) {
        if (order.expiresAt < new Date()) await this.prisma.order.updateMany({ where: { id: order.id, status: "PENDING_PAYMENT" }, data: { status: "EXPIRED" } });
        continue;
      }
      const paid = await this.confirm(order.id).catch(() => false);
      if (!paid && order.expiresAt.getTime() < Date.now() - 15 * 60_000) await this.prisma.order.updateMany({ where: { id: order.id, status: "PENDING_PAYMENT" }, data: { status: "EXPIRED" } });
    }
    return { checked: pending.length };
  }

  /**
   * Keystone refunds. A partner order also gives back seats: `seats` per package code are removed
   * first and must still be unused. Seats already used are refunded only with `allowUsedSeats`.
   */
  async refund(input: { orderId: string; amountPaise: number; reason: string; seats?: Record<string, number>; allowUsedSeats?: boolean; createdById: string }) {
    if (!Number.isInteger(input.amountPaise) || input.amountPaise < 100) throw new BadRequestException("amountPaise must be at least 100");
    if (input.reason.trim().length < 5) throw new BadRequestException("Give a reason of at least 5 characters");
    const order = await this.prisma.order.findUnique({ where: { id: input.orderId }, include: { lines: true, refunds: true } });
    if (!order) throw new NotFoundException("Order not found");
    if (order.status !== "PAID" && order.status !== "PARTIALLY_REFUNDED") throw new ConflictException("Only paid orders can be refunded");
    if (order.paidAt && Date.now() - order.paidAt.getTime() > 180 * 86_400_000) throw new ConflictException("Cashfree refunds are allowed only within 6 months of payment");
    if (input.amountPaise > order.totalPaise - order.refundedPaise) throw new BadRequestException(`At most ${order.totalPaise - order.refundedPaise} paise can still be refunded`);
    const id = refundId(order.id, order.refunds.length + 1);

    await this.prisma.$transaction(async (tx) => {
      if (order.buyerType === "PARTNER") {
        const seats = input.seats ?? {};
        if (!Object.keys(seats).length && !input.allowUsedSeats) throw new BadRequestException("Say how many seats this refund takes back, per package code");
        for (const [packageCode, count] of Object.entries(seats)) {
          if (!Number.isInteger(count) || count < 1) throw new BadRequestException(`${packageCode}: seats must be a positive whole number`);
          if (!order.lines.some((line) => line.packageCode === packageCode)) throw new BadRequestException(`${packageCode} is not on this order`);
          await this.seats.lock(tx, order.tenantId, packageCode);
          const balance = (await this.seats.balances(order.tenantId, tx)).find((item) => item.packageCode === packageCode);
          if ((balance?.available ?? 0) < count && !input.allowUsedSeats) throw new ConflictException(`Only ${balance?.available ?? 0} ${packageCode} seats are unused`);
          const version = order.lines.find((line) => line.packageCode === packageCode)!.packageVersion;
          await tx.seatLedger.create({ data: { id: `seat_${randomUUID()}`, tenantId: order.tenantId, packageCode, packageVersion: version, delta: -count, kind: "ADJUST", reason: `Refund ${id}: ${input.reason.trim()}`, createdById: input.createdById } });
        }
      }
      await tx.refund.create({ data: { id, orderId: order.id, tenantId: order.tenantId, amountPaise: input.amountPaise, status: "PENDING", reason: input.reason.trim(), createdById: input.createdById } });
      const refundedPaise = order.refundedPaise + input.amountPaise;
      await tx.order.update({ where: { id: order.id }, data: { refundedPaise, status: refundedPaise >= order.totalPaise ? "REFUNDED" : "PARTIALLY_REFUNDED" } });
    });

    try {
      const remote = await this.gateway.createRefund(order.id, { refundId: id, amount: rupees(input.amountPaise), note: input.reason.trim().slice(0, 100).padEnd(3, ".") });
      const status = remote.refund_status === "SUCCESS" ? "SUCCESS" : ["CANCELLED", "REJECTED"].includes(remote.refund_status) ? "FAILED" : "PENDING";
      await this.prisma.refund.update({ where: { id }, data: { status, cfRefundId: remote.cf_refund_id === undefined ? null : String(remote.cf_refund_id) } });
      return { refundId: id, status };
    } catch (error) {
      // Recorded as PENDING: reconcile with Cashfree before trying again, a retry could pay twice.
      this.logger.warn(`Refund ${id} not confirmed by Cashfree: ${(error as Error).message}`);
      return { refundId: id, status: "PENDING" };
    }
  }
}

export function orderView(order: OrderRow) {
  return {
    id: order.id, buyerType: order.buyerType, tenantId: order.tenantId, clientId: order.clientId, status: order.status, final: FINAL.has(order.status),
    subtotalPaise: order.subtotalPaise, discountPaise: order.discountPaise, taxablePaise: order.taxablePaise, cgstPaise: order.cgstPaise, sgstPaise: order.sgstPaise,
    igstPaise: order.igstPaise, totalPaise: order.totalPaise, refundedPaise: order.refundedPaise, paidAt: order.paidAt, expiresAt: order.expiresAt, createdAt: order.createdAt,
    lines: order.lines.map((line) => ({ packageCode: line.packageCode, packageVersion: line.packageVersion, quantity: line.quantity, unitPricePaise: line.unitPricePaise, addOns: line.addOns, discountBps: line.discountBps, discountPaise: line.discountPaise, packagePaise: line.packagePaise, addOnPaise: line.addOnPaise, lineTotalPaise: line.lineTotalPaise })),
    payments: order.payments.map((payment) => ({ status: payment.status, amountPaise: payment.amountPaise, method: payment.method, receivedAt: payment.receivedAt })),
    refunds: order.refunds.map((refund) => ({ id: refund.id, amountPaise: refund.amountPaise, status: refund.status, reason: refund.reason, createdAt: refund.createdAt })),
    invoice: order.invoice ? { number: order.invoice.number, issuedAt: order.invoice.issuedAt, sacCode: order.invoice.sacCode, buyerGstin: order.invoice.buyerGstin } : null
  };
}
