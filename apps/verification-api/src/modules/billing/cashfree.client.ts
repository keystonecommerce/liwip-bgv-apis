import { BadGatewayException, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Cashfree Payment Gateway (https://www.cashfree.com/docs). Server-side only: the browser
 * gets a payment_session_id and nothing else. Keys come from CASHFREE_APP_ID / CASHFREE_SECRET_KEY.
 */
export interface CashfreeOrderInput {
  orderId: string;
  amount: string;
  customer: { id: string; phone: string; name?: string; email?: string };
  returnUrl: string;
  notifyUrl?: string;
  expiresAt: Date;
  note?: string;
}

export interface CashfreeOrder {
  cf_order_id?: string | number;
  order_id: string;
  order_status: "ACTIVE" | "PAID" | "EXPIRED" | "TERMINATED" | "TERMINATION_REQUESTED" | string;
  order_amount?: number;
  payment_session_id?: string;
}

export interface CashfreePayment {
  cf_payment_id?: string | number;
  payment_status: string;
  payment_amount?: number;
  payment_group?: string;
  payment_time?: string;
}

export interface CashfreeRefund {
  cf_refund_id?: string | number;
  refund_id: string;
  refund_status: string;
  refund_amount?: number;
}

export interface PaymentGateway {
  readonly mode: "sandbox" | "production";
  createOrder(input: CashfreeOrderInput): Promise<CashfreeOrder>;
  getOrder(orderId: string): Promise<CashfreeOrder>;
  getPayments(orderId: string): Promise<CashfreePayment[]>;
  createRefund(orderId: string, refund: { refundId: string; amount: string; note: string }): Promise<CashfreeRefund>;
  /** True when the webhook's signature matches its raw body and timestamp. */
  verifyWebhook(rawBody: Buffer, timestamp: string, signature: string): boolean;
}

export const PAYMENT_GATEWAY = Symbol("PAYMENT_GATEWAY");

export class CashfreeError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) { super(message); }
}

/** Cashfree's signature: base64(HMAC-SHA256(timestamp + rawBody, secretKey)). */
export function cashfreeSignature(rawBody: Buffer, timestamp: string, secret: string): string {
  return createHmac("sha256", secret).update(timestamp).update(rawBody).digest("base64");
}

@Injectable()
export class CashfreeGateway implements PaymentGateway {
  get mode(): "sandbox" | "production" {
    return process.env.CASHFREE_ENV === "production" ? "production" : "sandbox";
  }

  private config() {
    const appId = process.env.CASHFREE_APP_ID;
    const secret = process.env.CASHFREE_SECRET_KEY;
    if (!appId || !secret) throw new ServiceUnavailableException("Payments are not configured");
    const base = this.mode === "production" ? "https://api.cashfree.com/pg" : "https://sandbox.cashfree.com/pg";
    return { appId, secret, base, version: process.env.CASHFREE_API_VERSION || "2025-01-01" };
  }

  private async call<T>(method: "GET" | "POST", path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
    const { appId, secret, base, version } = this.config();
    let response: Response;
    try {
      response = await fetch(`${base}${path}`, {
        method,
        headers: {
          "x-client-id": appId,
          "x-client-secret": secret,
          "x-api-version": version,
          "content-type": "application/json",
          ...(idempotencyKey ? { "x-idempotency-key": idempotencyKey } : {})
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
        redirect: "error"
      });
    } catch {
      throw new BadGatewayException("The payment provider did not respond. Try again.");
    }
    const json = (await response.json().catch(() => null)) as (T & { message?: string; code?: string }) | null;
    if (!response.ok || !json) throw new CashfreeError(json?.message || `Cashfree returned ${response.status}`, response.status, json?.code);
    return json;
  }

  createOrder(input: CashfreeOrderInput) {
    return this.call<CashfreeOrder>("POST", "/orders", {
      order_id: input.orderId,
      order_amount: Number(input.amount),
      order_currency: "INR",
      customer_details: {
        customer_id: input.customer.id,
        customer_phone: input.customer.phone,
        customer_name: input.customer.name,
        customer_email: input.customer.email
      },
      order_meta: { return_url: input.returnUrl, notify_url: input.notifyUrl },
      order_expiry_time: input.expiresAt.toISOString(),
      order_note: input.note
    }, input.orderId);
  }

  getOrder(orderId: string) {
    return this.call<CashfreeOrder>("GET", `/orders/${encodeURIComponent(orderId)}`);
  }

  getPayments(orderId: string) {
    return this.call<CashfreePayment[]>("GET", `/orders/${encodeURIComponent(orderId)}/payments`);
  }

  createRefund(orderId: string, refund: { refundId: string; amount: string; note: string }) {
    return this.call<CashfreeRefund>("POST", `/orders/${encodeURIComponent(orderId)}/refunds`, {
      refund_id: refund.refundId,
      refund_amount: Number(refund.amount),
      refund_note: refund.note
    }, refund.refundId);
  }

  verifyWebhook(rawBody: Buffer, timestamp: string, signature: string): boolean {
    const secret = process.env.CASHFREE_SECRET_KEY;
    if (!secret || !timestamp || !signature) return false;
    const expected = Buffer.from(cashfreeSignature(rawBody, timestamp, secret));
    const given = Buffer.from(signature);
    return expected.length === given.length && timingSafeEqual(expected, given);
  }
}
