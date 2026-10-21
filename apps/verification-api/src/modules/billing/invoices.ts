import type { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { billingConfig, financialYear } from "./billing-config";

export interface InvoiceSource {
  /** Exactly one of these. */
  orderId?: string;
  statementId?: string;
  tenantId: string;
  individual: boolean;
  taxablePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  totalPaise: number;
}

/** Issues the next number in the financial year's single series (LBV/2026-27/00001), for an order or a usage statement. */
export async function issueInvoice(tx: Prisma.TransactionClient, source: InvoiceSource) {
  const config = billingConfig();
  const year = financialYear();
  const counter = await tx.invoiceCounter.upsert({ where: { financialYear: year }, create: { financialYear: year, next: 2 }, update: { next: { increment: 1 } } });
  const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: source.tenantId }, select: { name: true, legalName: true, gstin: true, address: true } });
  const address = tenant.address as { state?: string } | null;
  return tx.invoice.create({
    data: {
      id: `invoice_${randomUUID()}`, number: `LBV/${year}/${String(counter.next - 1).padStart(5, "0")}`,
      orderId: source.orderId ?? null, statementId: source.statementId ?? null, tenantId: source.tenantId,
      buyerName: source.individual ? "Individual" : tenant.legalName || tenant.name, buyerGstin: source.individual ? null : tenant.gstin,
      buyerState: source.individual ? null : address?.state ?? null,
      sellerName: config.sellerName, sellerGstin: config.sellerGstin, sellerState: config.sellerState, sacCode: config.sacCode,
      taxablePaise: source.taxablePaise, cgstPaise: source.cgstPaise, sgstPaise: source.sgstPaise, igstPaise: source.igstPaise, totalPaise: source.totalPaise
    }
  });
}
