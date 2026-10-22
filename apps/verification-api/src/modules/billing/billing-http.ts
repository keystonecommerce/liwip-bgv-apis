import { BadRequestException } from "@nestjs/common";
import { panelUrl } from "../admin-access/admin-config";
import { AdminContext, scopedTenantId } from "../admin-access/admin-context";
import { id, text } from "../admin-panel/input";
import { IST_MS } from "./billing-config";

// Small request helpers shared by the billing controllers.

/** The partner a buying request acts for. Keystone staff pick one with x-partner-id. */
export function buyingPartner(admin: AdminContext): string {
  const tenantId = scopedTenantId(admin);
  if (!tenantId) throw new BadRequestException("Choose a partner (x-partner-id) to buy for");
  return tenantId;
}


/** A YYYY-MM-DD day in India time, as the instant it starts. */
export function istDay(value: string | undefined, label: string): Date | undefined {
  if (value === undefined || value === "") return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new BadRequestException(`${label} must be YYYY-MM-DD`);
  const date = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new BadRequestException(`${label} is not a date`);
  return new Date(date.getTime() - IST_MS);
}

export function period(value: unknown): string {
  const text = String(value ?? "");
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(text)) throw new BadRequestException("period must look like 2026-10");
  return text;
}

// Partners pay in the business portal, so Cashfree sends them back there (also when Keystone buys for one).
export const partnerReturnUrl = () => process.env.BILLING_PARTNER_RETURN_URL || `${panelUrl("business")}/billing/orders/{order_id}`;
