import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../../common/database/prisma.service";
import { billingConfig } from "./billing-config";
import { CatalogService, packageCode } from "./catalog.service";
import { checkType } from "./check-rates.service";
import { LineInput, priceOrder } from "./pricing";

export interface QuoteLineRequest { packageCode?: string; quantity?: number; addOns?: string[] }

export interface Buyer {
  type: "PARTNER" | "INDIVIDUAL";
  tenantId: string;
  clientId?: string | null;
  applicationId?: string | null;
  createdById?: string | null;
}

/** The state from a partner's address ({ state }), for CGST/SGST vs IGST. */
const stateOf = (address: unknown) => (address && typeof address === "object" && typeof (address as { state?: unknown }).state === "string" ? (address as { state: string }).state : null);

@Injectable()
export class QuoteService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService, @Inject(CatalogService) private readonly catalog: CatalogService) {}

  /** Prices the request at today's published versions and stores the result for checkout. */
  async create(buyer: Buyer, linesValue: unknown) {
    if (!Array.isArray(linesValue) || !linesValue.length || linesValue.length > 20) throw new BadRequestException("lines must list 1 to 20 packages");
    const requests = linesValue as QuoteLineRequest[];
    if (buyer.type === "INDIVIDUAL" && (requests.length !== 1 || (requests[0]?.quantity ?? 1) !== 1)) throw new BadRequestException("An individual buys one package for themselves");
    const codes = requests.map((line) => packageCode(line.packageCode));
    if (new Set(codes).size !== codes.length) throw new BadRequestException("List each package once");
    const addOnTypes = requests.flatMap((line) => (Array.isArray(line.addOns) ? line.addOns.map(checkType) : []));
    // Company seats carry no add-ons: an extra check on an invited case is billed as API usage.
    if (buyer.type === "PARTNER" && addOnTypes.length) throw new BadRequestException("Seats carry no add-ons; extra checks on a company's cases are billed per check");
    const inputs = await this.catalog.pricingInputs(buyer.type === "PARTNER" ? buyer.tenantId : null, codes, addOnTypes);

    const lines: LineInput[] = requests.map((line, index) => {
      const code = codes[index];
      const base = inputs.published.get(code);
      if (!base) throw new NotFoundException(`${code} is not on sale`);
      const quantity = buyer.type === "INDIVIDUAL" ? 1 : line.quantity;
      if (!Number.isInteger(quantity) || (quantity as number) < 1 || (quantity as number) > 100_000) throw new BadRequestException(`${code}: quantity must be 1 to 100000`);
      const allowed = inputs.allowedAddOns(code);
      const addOns = [...new Set(Array.isArray(line.addOns) ? line.addOns.map(checkType) : [])].map((type) => {
        const addOn = allowed.has(type) ? inputs.addOn(type) : null;
        if (!addOn) throw new BadRequestException(`${type} is not offered with ${code}`);
        return addOn;
      });
      return { item: base.item, quantity: quantity as number, addOns, partnerUnitPaise: inputs.partnerPrice(code) };
    });

    const tenant = await this.prisma.tenant.findUnique({ where: { id: buyer.tenantId }, select: { address: true, status: true } });
    if (!tenant || tenant.status !== "ACTIVE") throw new NotFoundException("Buyer not found");
    const config = billingConfig();
    const priced = priceOrder(lines, inputs.tiers, { rateBps: config.gstRateBps, sellerState: config.sellerState, buyerState: buyer.type === "PARTNER" ? stateOf(tenant.address) : null });
    const quote = await this.prisma.quote.create({
      data: {
        id: `quote_${randomUUID()}`, buyerType: buyer.type, tenantId: buyer.tenantId, clientId: buyer.clientId ?? null, applicationId: buyer.applicationId ?? null,
        lines: priced.lines as unknown as Prisma.InputJsonValue, subtotalPaise: priced.subtotalPaise, discountPaise: priced.discountPaise, taxablePaise: priced.taxablePaise,
        cgstPaise: priced.cgstPaise, sgstPaise: priced.sgstPaise, igstPaise: priced.igstPaise, totalPaise: priced.totalPaise,
        expiresAt: new Date(Date.now() + config.quoteMinutes * 60_000), createdById: buyer.createdById ?? null
      }
    });
    return quoteView(quote);
  }
}

export function quoteView(quote: Prisma.QuoteGetPayload<object>) {
  return {
    id: quote.id, buyerType: quote.buyerType, lines: quote.lines, subtotalPaise: quote.subtotalPaise, discountPaise: quote.discountPaise,
    taxablePaise: quote.taxablePaise, cgstPaise: quote.cgstPaise, sgstPaise: quote.sgstPaise, igstPaise: quote.igstPaise, totalPaise: quote.totalPaise,
    expiresAt: quote.expiresAt
  };
}
