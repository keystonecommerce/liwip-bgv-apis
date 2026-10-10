import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../common/database/prisma.service";
export interface UsageQuery { from?: Date; to?: Date; tenantId?: string; clientId?: string }
export function usagePeriod(query: UsageQuery) {
  const to = query.to ?? new Date();
  const from = query.from ?? new Date(to.getTime() - 30 * 86400000);
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from >= to || to.getTime() - from.getTime() > 366 * 86400000) throw new BadRequestException("Usage period must be valid, ordered, and no longer than 366 days");
  return { from, to };
}
export function parseUsageDate(value?: string): Date | undefined {
  if (value === undefined) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)?$/.test(value)) throw new BadRequestException("Usage dates must be ISO UTC dates or timestamps");
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value.slice(0, 10)) throw new BadRequestException("Invalid usage date");
  return date;
}
@Injectable()
export class UsageService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}
  /** Operator report is explicitly global; partner report requires both identities. */
  getPartnerUsage(owner: { tenantId: string; clientId: string }, query: Pick<UsageQuery, "from" | "to">) {
    if (!owner.tenantId || !owner.clientId) throw new BadRequestException("Partner ownership is required");
    return this.getUsage({ ...query, tenantId: owner.tenantId, clientId: owner.clientId });
  }
  async getUsage(query: UsageQuery) {
    const period = usagePeriod(query);
    const owner = { ...(query.tenantId ? { tenantId: query.tenantId } : {}), ...(query.clientId ? { clientId: query.clientId } : {}) };
    return this.prisma.$transaction(async tx => {
      const calls = await tx.providerCall.groupBy({ by: ["tenantId", "clientId", "state", "provider", "operation", "apiKeyId"], where: { ...owner, startedAt: { gte: period.from, lt: period.to } }, _count: { _all: true } });
      const outcomes = await tx.verification.groupBy({ by: ["applicationId", "status"], where: { application: owner, completedAt: { gte: period.from, lt: period.to }, status: { in: ["VERIFIED", "FAILED", "MANUAL_REVIEW"] } }, _count: { _all: true } });
      const applications = await tx.application.findMany({ where: { ...owner, id: { in: outcomes.map(row => row.applicationId) } }, select: { id: true, tenantId: true, clientId: true } });
      const partners = new Map<string, { tenantId: string; clientId: string; billable: number; successfulApiCalls: number; nonBillable: number; pendingReconciliation: number; total: number; verifiedChecks: number; byState: Record<string, number>; byOperation: Record<string, number>; byProvider: Record<string, number>; byApiKey: Record<string, number> }>();
      const ensure = (tenantId: string, clientId: string) => {
        const key = JSON.stringify([tenantId, clientId]);
        if (!partners.has(key)) partners.set(key, { tenantId, clientId, billable: 0, successfulApiCalls: 0, nonBillable: 0, pendingReconciliation: 0, total: 0, verifiedChecks: 0, byState: {}, byOperation: {}, byProvider: {}, byApiKey: {} });
        return partners.get(key)!;
      };
      for (const row of calls) {
        const p = ensure(row.tenantId, row.clientId), n = row._count._all;
        p.total += n;
        p.byState[row.state] = (p.byState[row.state] ?? 0) + n;
        if (row.state === "SUCCESS") {
          p.successfulApiCalls += n; p.billable += n;
          p.byOperation[row.operation] = (p.byOperation[row.operation] ?? 0) + n;
          p.byProvider[row.provider] = (p.byProvider[row.provider] ?? 0) + n;
          if (row.apiKeyId) p.byApiKey[row.apiKeyId] = (p.byApiKey[row.apiKeyId] ?? 0) + n;
        } else if (row.state === "REJECTED") p.nonBillable += n;
        else p.pendingReconciliation += n;
      }
      const owners = new Map(applications.map(a => [a.id, a]));
      for (const outcome of outcomes) {
        const application = owners.get(outcome.applicationId);
        if (application && outcome.status === "VERIFIED") ensure(application.tenantId, application.clientId).verifiedChecks += outcome._count._all;
      }
      const rows = [...partners.values()].sort((a, b) => b.successfulApiCalls - a.successfulApiCalls || a.clientId.localeCompare(b.clientId));
      return { period: { ...period, endExclusive: true }, billingBasis: "CONFIRMED_SUCCESSFUL_PROVIDER_CALLS", totalBillable: rows.reduce((n, r) => n + r.billable, 0), totalSuccessfulApiCalls: rows.reduce((n, r) => n + r.successfulApiCalls, 0), totalVerifiedChecks: rows.reduce((n, r) => n + r.verifiedChecks, 0), pendingReconciliation: rows.reduce((n, r) => n + r.pendingReconciliation, 0), partners: rows };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }
}
