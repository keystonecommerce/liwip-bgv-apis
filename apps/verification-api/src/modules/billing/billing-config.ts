/** Billing settings from env, read when used so tests can change them. */
export const billingConfig = () => ({
  /** GST in basis points (1800 = 18%). */
  gstRateBps: Number(process.env.BILLING_GST_BPS || 1800),
  /** Keystone's registration that issues every BGV invoice (state code 29 = Karnataka). */
  sellerName: process.env.BILLING_SELLER_NAME || "Keystone Commerce Private Limited",
  sellerGstin: process.env.BILLING_SELLER_GSTIN || "29AAMCK2232K1Z9",
  sellerAddress: process.env.BILLING_SELLER_ADDRESS || "No. 51, 5th Floor, Tower A, Dr Rajkumar Road, Bengaluru, Bengaluru Urban, Karnataka, 560103, India",
  /** The state of that GSTIN, for CGST/SGST vs IGST. */
  sellerState: process.env.BILLING_SELLER_STATE || "Karnataka",
  /** SAC 998521, investigation services (background verification), 18%. To be confirmed with the CA. */
  sacCode: process.env.BILLING_SAC_CODE || "998521",
  quoteMinutes: 30,
  orderMinutes: 30,
  inviteDays: Number(process.env.INVITE_VALID_DAYS || 30),
  /** Where invite links land: the Liwip app. */
  workerAppUrl: (process.env.WORKER_APP_URL || "http://localhost:3005").replace(/\/+$/, ""),
  /** Public base for invite links, e.g. https://liwip.in. */
  inviteLinkBase: (process.env.INVITE_LINK_BASE || "http://localhost:3001").replace(/\/+$/, ""),
  /**
   * Checks before this instant are never billed as API usage. Unset: usage is not rated at all,
   * so turning billing on never back-bills a partner's history.
   */
  usageStart: process.env.BILLING_USAGE_START ? new Date(process.env.BILLING_USAGE_START) : null,
  statementDueDays: Number(process.env.BILLING_STATEMENT_DUE_DAYS || 15)
});

/** Billing calendars run on India time, whatever the server's timezone. */
const IST_MS = 330 * 60_000;
const inIndia = (date: Date) => new Date(date.getTime() + IST_MS);

/** Financial year label for invoice numbers: April to March in India time, e.g. 2026-27. */
export function financialYear(date = new Date()): string {
  const local = inIndia(date);
  const year = local.getUTCMonth() >= 3 ? local.getUTCFullYear() : local.getUTCFullYear() - 1;
  return `${year}-${String((year + 1) % 100).padStart(2, "0")}`;
}

/** The India-time month an instant falls in, e.g. 2026-10. */
export const periodOf = (date: Date) => inIndia(date).toISOString().slice(0, 7);

/** The instants an India-time month starts and ends (end exclusive). */
export function periodRange(period: string) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw new Error("Period must look like 2026-10");
  const [year, month] = period.split("-").map(Number);
  return { from: new Date(Date.UTC(year, month - 1, 1) - IST_MS), to: new Date(Date.UTC(year, month, 1) - IST_MS) };
}

/** The month before the one this instant falls in. */
export function previousPeriod(date = new Date()) {
  return periodOf(new Date(periodRange(periodOf(date)).from.getTime() - 1));
}
