/**
 * Pure pricing: no database, no clock beyond what callers pass in. Money is integer paise.
 * Per line: unit price (partner price, else list) → one bulk discount tier on the package part
 * (best partner tier, else best global tier) → add-on checks at their check price → line total.
 * GST on the order's taxable value. The package part and the add-on part are kept apart: they
 * are the two kinds of sale (docs/PRICING-AND-PAYMENTS.md §0).
 */

export interface PricedItem {
  id: string;
  code: string;
  version: number;
  name: string;
  listPricePaise: number;
}

/** An extra check sold with a package, priced from its CheckRate. */
export interface AddOnItem {
  checkType: string;
  checkRateId: string;
  unitPricePaise: number;
}

export interface LineInput {
  item: PricedItem;
  quantity: number;
  addOns: AddOnItem[];
  /** A negotiated price for this partner, replacing the list price. */
  partnerUnitPaise?: number | null;
  /** Checks bought for a case under way: the case's package is already paid, so only the add-ons are charged. */
  extras?: boolean;
}

export interface DiscountTier {
  id: string;
  scope: "GLOBAL" | "PARTNER";
  packageCode: string | null;
  minQty: number;
  maxQty: number | null;
  percentOffBps: number;
}

export interface TaxContext {
  /** GST rate in basis points (1800 = 18%). */
  rateBps: number;
  sellerState: string;
  /** null: taxed as intra-state (individuals, or no address on file). */
  buyerState: string | null;
}

export interface PricedLine {
  /** PACKAGE, or EXTRAS: add-on checks only, on the case's own package. */
  kind: "PACKAGE" | "EXTRAS";
  packageId: string;
  packageCode: string;
  packageVersion: number;
  name: string;
  quantity: number;
  unitListPaise: number;
  unitPricePaise: number;
  addOns: AddOnItem[];
  grossPaise: number;
  discountRuleId: string | null;
  discountBps: number;
  discountPaise: number;
  /** The package sale after discount. */
  packagePaise: number;
  /** The add-on check sale. */
  addOnPaise: number;
  lineTotalPaise: number;
}

export interface PricedOrder {
  lines: PricedLine[];
  subtotalPaise: number;
  discountPaise: number;
  packagePaise: number;
  addOnPaise: number;
  taxablePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  totalPaise: number;
}

const inRange = (tier: DiscountTier, quantity: number) => quantity >= tier.minQty && (tier.maxQty === null || quantity <= tier.maxQty);
const applies = (tier: DiscountTier, code: string) => tier.packageCode === null || tier.packageCode === code;

/** The tier for a line: partner tiers beat global ones; within a scope the largest discount wins. */
export function tierFor(tiers: readonly DiscountTier[], packageCode: string, quantity: number): DiscountTier | null {
  const matching = tiers.filter((tier) => applies(tier, packageCode) && inRange(tier, quantity));
  const pool = matching.some((tier) => tier.scope === "PARTNER") ? matching.filter((tier) => tier.scope === "PARTNER") : matching;
  return pool.reduce<DiscountTier | null>((best, tier) => (!best || tier.percentOffBps > best.percentOffBps ? tier : best), null);
}

const normalState = (value: string | null | undefined) => (value ?? "").trim().toUpperCase().replace(/\s+/g, " ");

export function priceOrder(inputs: readonly LineInput[], tiers: readonly DiscountTier[], tax: TaxContext): PricedOrder {
  if (!inputs.length) throw new Error("An order needs at least one line");
  const lines = inputs.map((input): PricedLine => {
    if (!Number.isInteger(input.quantity) || input.quantity < 1) throw new Error("Quantity must be a positive whole number");
    const unitPricePaise = input.extras ? 0 : input.partnerUnitPaise ?? input.item.listPricePaise;
    const addOns = input.addOns.map((addOn) => ({ checkType: addOn.checkType, checkRateId: addOn.checkRateId, unitPricePaise: addOn.unitPricePaise }));
    const packageGross = unitPricePaise * input.quantity;
    const addOnPaise = addOns.reduce((sum, addOn) => sum + addOn.unitPricePaise, 0) * input.quantity;
    const tier = input.extras ? null : tierFor(tiers, input.item.code, input.quantity);
    const discountBps = tier?.percentOffBps ?? 0;
    const discountPaise = Math.round((packageGross * discountBps) / 10_000);
    return {
      kind: input.extras ? "EXTRAS" : "PACKAGE",
      packageId: input.item.id,
      packageCode: input.item.code,
      packageVersion: input.item.version,
      name: input.item.name,
      quantity: input.quantity,
      unitListPaise: input.extras ? 0 : input.item.listPricePaise,
      unitPricePaise,
      addOns,
      grossPaise: packageGross + addOnPaise,
      discountRuleId: tier?.id ?? null,
      discountBps,
      discountPaise,
      packagePaise: packageGross - discountPaise,
      addOnPaise,
      lineTotalPaise: packageGross - discountPaise + addOnPaise
    };
  });
  const subtotalPaise = lines.reduce((sum, line) => sum + line.grossPaise, 0);
  const discountPaise = lines.reduce((sum, line) => sum + line.discountPaise, 0);
  const taxablePaise = subtotalPaise - discountPaise;
  const { cgstPaise, sgstPaise, igstPaise, gstPaise } = gstSplit(taxablePaise, tax);
  const packagePaise = lines.reduce((sum, line) => sum + line.packagePaise, 0);
  const addOnPaise = lines.reduce((sum, line) => sum + line.addOnPaise, 0);
  return { lines, subtotalPaise, discountPaise, packagePaise, addOnPaise, taxablePaise, cgstPaise, sgstPaise, igstPaise, totalPaise: taxablePaise + gstPaise };
}

/** GST on a taxable amount: CGST + SGST within Keystone's state (or with no buyer state), IGST otherwise. */
export function gstSplit(taxablePaise: number, tax: TaxContext) {
  const gstPaise = Math.round((taxablePaise * tax.rateBps) / 10_000);
  const interState = tax.buyerState !== null && normalState(tax.buyerState) !== normalState(tax.sellerState);
  const cgstPaise = interState ? 0 : Math.floor(gstPaise / 2);
  return { gstPaise, cgstPaise, sgstPaise: interState ? 0 : gstPaise - cgstPaise, igstPaise: interState ? gstPaise : 0 };
}

/** Paise to the "1234.50" string Cashfree's order_amount takes. */
export const rupees = (paise: number) => (paise / 100).toFixed(2);
