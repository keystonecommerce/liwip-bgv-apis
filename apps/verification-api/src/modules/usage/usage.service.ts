import { Inject, Injectable } from "@nestjs/common";
import { PrismaService } from "../../common/database/prisma.service";

export interface UsageQuery {
  from?: Date;
  to?: Date;
  tenantId?: string;
  clientId?: string;
}

/**
 * Reads the UsageEvent ledger for billing. "Billable" = the provider actually
 * did the work (VERIFIED / NEGATIVE / MANUAL_REVIEW); provider/system errors are
 * recorded with billable=false and excluded from the billable count.
 */
@Injectable()
export class UsageService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async getUsage(query: UsageQuery) {
    const where = {
      ...(query.tenantId ? { tenantId: query.tenantId } : {}),
      ...(query.clientId ? { clientId: query.clientId } : {}),
      ...(query.from || query.to
        ? { createdAt: { ...(query.from ? { gte: query.from } : {}), ...(query.to ? { lte: query.to } : {}) } }
        : {}),
    };

    // Per-partner totals (billable vs total).
    const byPartner = await this.prisma.usageEvent.groupBy({
      by: ["tenantId", "clientId", "billable"],
      where,
      _count: { _all: true },
    });
    // Per-partner breakdown by result (VERIFIED/NEGATIVE/MANUAL_REVIEW/ERROR).
    const byResult = await this.prisma.usageEvent.groupBy({
      by: ["tenantId", "clientId", "result"],
      where,
      _count: { _all: true },
    });
    // Per-partner breakdown by check type.
    const byType = await this.prisma.usageEvent.groupBy({
      by: ["tenantId", "clientId", "checkType"],
      where,
      _count: { _all: true },
    });

    const partners = new Map<string, {
      tenantId: string;
      clientId: string;
      billable: number;
      nonBillable: number;
      total: number;
      byResult: Record<string, number>;
      byCheckType: Record<string, number>;
    }>();
    const keyOf = (t: string, c: string) => `${t}::${c}`;
    const ensure = (tenantId: string, clientId: string) => {
      const key = keyOf(tenantId, clientId);
      if (!partners.has(key)) {
        partners.set(key, { tenantId, clientId, billable: 0, nonBillable: 0, total: 0, byResult: {}, byCheckType: {} });
      }
      return partners.get(key)!;
    };

    for (const row of byPartner) {
      const p = ensure(row.tenantId, row.clientId);
      const n = row._count._all;
      if (row.billable) p.billable += n;
      else p.nonBillable += n;
      p.total += n;
    }
    for (const row of byResult) {
      ensure(row.tenantId, row.clientId).byResult[row.result] = row._count._all;
    }
    for (const row of byType) {
      ensure(row.tenantId, row.clientId).byCheckType[row.checkType] = row._count._all;
    }

    const rows = Array.from(partners.values()).sort((a, b) => b.billable - a.billable);
    const totalBillable = rows.reduce((sum, r) => sum + r.billable, 0);

    return {
      period: { from: query.from ?? null, to: query.to ?? null },
      totalBillable,
      partners: rows,
    };
  }
}
