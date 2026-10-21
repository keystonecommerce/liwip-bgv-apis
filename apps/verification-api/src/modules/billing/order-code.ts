import { randomInt } from "node:crypto";

/** Uppercase letters and digits without look-alikes (no 0, O, 1, I, L): 31 characters. */
export const ORDER_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const ORDER_CODE = /^[2-9A-HJKMNP-Z]{10}$/;

/** A 10-character order code, e.g. K7QM4XT9PB. Also Cashfree's order_id. */
export function newOrderCode(): string {
  let code = "";
  for (let i = 0; i < 10; i++) code += ORDER_CODE_ALPHABET[randomInt(ORDER_CODE_ALPHABET.length)];
  return code;
}

/** Refund ids are the order code plus R1, R2, ... */
export const refundId = (orderCode: string, n: number) => `${orderCode}R${n}`;
