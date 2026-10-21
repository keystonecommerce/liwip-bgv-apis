import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../common/database/prisma.service";
import { periodOf } from "./billing-config";
import { UsageBillingService } from "./usage-billing.service";

const PAID = ["PAID", "PARTIALLY_REFUNDED", "REFUNDED"];

interface Stream { packagesPaise: number; addOnsPaise: number; apiUsagePaise: number }
const empty = (): Stream => ({ packagesPaise: 0, addOnsPaise: 0, apiUsagePaise: 0 });

/**
 * Keystone's revenue, net of GST, in the two kinds of sale (docs/PRICING-AND-PAYMENTS.md §0):
 * packages, and checks (add-ons bought with a package plus partners' metered API usage).
 */
@Injectable()
export class RevenueService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService, @Inject(UsageBillingService) private readonly usage: UsageBillingService) {}

  async report(query: { from: Date; to: Date; tenantId?: string }) {
    const { from, to, tenantId } = query;
    if (!(from < to) || to.getTime() - from.getTime() > 400 * 86_400_000) throw new BadRequestException("Choose a period of up to 400 days");
    const scope = tenantId ? { tenantId } : {};

    const [lines, refunds, charges, statementsIssued, outstanding, unrated] = await Promise.all([
      this.prisma.orderLine.findMany({
        where: { ...scope, order: { status: { in: PAID }, paidAt: { gte: from, lt: to } } },
        select: { packageCode: true, quantity: true, packagePaise: true, addOnPaise: true, addOns: true, tenantId: true, order: { select: { buyerType: true, paidAt: true, cgstPaise: true, sgstPaise: true, igstPaise: true, id: true } } }
      }),
      this.prisma.refund.findMany({
        where: { ...scope, status: { not: "FAILED" }, createdAt: { gte: from, lt: to } },
        select: { amountPaise: true, createdAt: true, tenantId: true, order: { select: { taxablePaise: true, totalPaise: true, lines: { select: { packagePaise: true, addOnPaise: true } } } } }
      }),
      this.prisma.usageCharge.groupBy({ by: ["tenantId", "checkType", "statementId"], where: { ...scope, occurredAt: { gte: from, lt: to } }, _sum: { unitPricePaise: true }, _count: { _all: true } }),
      this.prisma.usageStatement.findMany({ where: { ...scope, status: { not: "VOID" }, issuedAt: { gte: from, lt: to } }, select: { cgstPaise: true, sgstPaise: true, igstPaise: true } }),
      this.prisma.usageStatement.findMany({ where: { ...scope, status: "ISSUED" }, select: { totalPaise: true, dueAt: true } }),
      this.usage.unrated(from, to, tenantId)
    ]);
    // Monthly usage needs the day each check ran, so it is read per month rather than grouped above.
    const usageByMonth = await this.prisma.$queryRaw<Array<{ period: string; amount: bigint }>>`
      SELECT to_char("occurredAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM') AS period, SUM("unitPricePaise")::bigint AS amount
      FROM "UsageCharge" WHERE "occurredAt" >= ${from} AND "occurredAt" < ${to} ${tenantId ? Prisma.sql`AND "tenantId" = ${tenantId}` : Prisma.empty}
      GROUP BY 1`;

    const totals = empty();
    const months = new Map<string, Stream>();
    const month = (key: string) => { if (!months.has(key)) months.set(key, empty()); return months.get(key)!; };
    const partners = new Map<string, Stream>();
    const partner = (id: string) => { if (!partners.has(id)) partners.set(id, empty()); return partners.get(id)!; };
    const byPackage = new Map<string, { packageCode: string; amountPaise: number; seats: number; individuals: number }>();
    const byCheck = new Map<string, { checkType: string; addOnsPaise: number; addOnCount: number; apiUsagePaise: number; apiCount: number }>();
    const check = (type: string) => { if (!byCheck.has(type)) byCheck.set(type, { checkType: type, addOnsPaise: 0, addOnCount: 0, apiUsagePaise: 0, apiCount: 0 }); return byCheck.get(type)!; };
    let gstPaise = 0;
    const gstOrders = new Set<string>();

    for (const line of lines) {
      totals.packagesPaise += line.packagePaise; totals.addOnsPaise += line.addOnPaise;
      const m = month(periodOf(line.order.paidAt!)); m.packagesPaise += line.packagePaise; m.addOnsPaise += line.addOnPaise;
      const p = partner(line.tenantId); p.packagesPaise += line.packagePaise; p.addOnsPaise += line.addOnPaise;
      const pkg = byPackage.get(line.packageCode) ?? { packageCode: line.packageCode, amountPaise: 0, seats: 0, individuals: 0 };
      pkg.amountPaise += line.packagePaise;
      if (line.order.buyerType === "PARTNER") pkg.seats += line.quantity; else pkg.individuals += line.quantity;
      byPackage.set(line.packageCode, pkg);
      for (const addOn of (line.addOns as Array<{ checkType?: string; unitPricePaise?: number }>) ?? []) {
        if (!addOn?.checkType) continue;
        const c = check(addOn.checkType); c.addOnsPaise += (addOn.unitPricePaise ?? 0) * line.quantity; c.addOnCount += line.quantity;
      }
      if (!gstOrders.has(line.order.id)) { gstOrders.add(line.order.id); gstPaise += line.order.cgstPaise + line.order.sgstPaise + line.order.igstPaise; }
    }

    let invoicedPaise = 0, notInvoicedPaise = 0, apiChecks = 0;
    for (const row of charges) {
      const amount = row._sum.unitPricePaise ?? 0;
      totals.apiUsagePaise += amount; apiChecks += row._count._all;
      if (row.statementId) invoicedPaise += amount; else notInvoicedPaise += amount;
      partner(row.tenantId).apiUsagePaise += amount;
      const c = check(row.checkType); c.apiUsagePaise += amount; c.apiCount += row._count._all;
    }
    for (const row of usageByMonth) month(row.period).apiUsagePaise += Number(row.amount);
    for (const statement of statementsIssued) gstPaise += statement.cgstPaise + statement.sgstPaise + statement.igstPaise;

    // Refunds are net of GST and taken from the order's package sale first, then its add-ons.
    let refundPackages = 0, refundAddOns = 0;
    for (const refund of refunds) {
      const net = refund.order.totalPaise ? Math.round((refund.amountPaise * refund.order.taxablePaise) / refund.order.totalPaise) : 0;
      const packageTotal = refund.order.lines.reduce((sum, line) => sum + line.packagePaise, 0);
      const fromPackages = Math.min(net, packageTotal);
      refundPackages += fromPackages; refundAddOns += net - fromPackages;
      const p = partner(refund.tenantId); p.packagesPaise -= fromPackages; p.addOnsPaise -= net - fromPackages;
      const m = month(periodOf(refund.createdAt)); m.packagesPaise -= fromPackages; m.addOnsPaise -= net - fromPackages;
    }

    const names = new Map((await this.prisma.tenant.findMany({ where: { id: { in: [...partners.keys()] } }, select: { id: true, name: true, kind: true } })).map((row) => [row.id, row]));
    const sum = (s: Stream) => s.packagesPaise + s.addOnsPaise + s.apiUsagePaise;
    const packagesNet = totals.packagesPaise - refundPackages;
    const checksNet = totals.addOnsPaise + totals.apiUsagePaise - refundAddOns;
    const now = new Date();

    return {
      period: { from, to, endExclusive: true },
      currency: "INR",
      packages: { salesPaise: totals.packagesPaise, refundsPaise: refundPackages, netPaise: packagesNet, seatsSold: [...byPackage.values()].reduce((n, row) => n + row.seats, 0), individualPackages: [...byPackage.values()].reduce((n, row) => n + row.individuals, 0) },
      checks: {
        addOnsPaise: totals.addOnsPaise, apiUsagePaise: totals.apiUsagePaise, refundsPaise: refundAddOns, netPaise: checksNet,
        apiChecks, apiInvoicedPaise: invoicedPaise, apiNotInvoicedPaise: notInvoicedPaise,
        unratedChecks: unrated.total, unratedByCheckType: unrated.byCheckType, usageBillingStarted: unrated.started
      },
      totals: { salesPaise: totals.packagesPaise + totals.addOnsPaise + totals.apiUsagePaise, refundsPaise: refundPackages + refundAddOns, netPaise: packagesNet + checksNet, gstPaise },
      outstanding: {
        statements: outstanding.length, amountPaise: outstanding.reduce((n, row) => n + row.totalPaise, 0),
        overdueStatements: outstanding.filter((row) => row.dueAt < now).length, overduePaise: outstanding.filter((row) => row.dueAt < now).reduce((n, row) => n + row.totalPaise, 0)
      },
      byMonth: [...months.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([period, s]) => ({ period, packagesPaise: s.packagesPaise, checksPaise: s.addOnsPaise + s.apiUsagePaise, addOnsPaise: s.addOnsPaise, apiUsagePaise: s.apiUsagePaise })),
      byPackage: [...byPackage.values()].sort((a, b) => b.amountPaise - a.amountPaise),
      byCheckType: [...byCheck.values()].sort((a, b) => b.addOnsPaise + b.apiUsagePaise - (a.addOnsPaise + a.apiUsagePaise)),
      byPartner: [...partners.entries()].map(([id, s]) => ({ partner: { id, name: names.get(id)?.name ?? id, direct: names.get(id)?.kind === "DIRECT" }, packagesPaise: s.packagesPaise, checksPaise: s.addOnsPaise + s.apiUsagePaise, apiUsagePaise: s.apiUsagePaise, totalPaise: sum(s) })).sort((a, b) => b.totalPaise - a.totalPaise)
    };
  }
}
