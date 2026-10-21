import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { AuditService } from "../../common/audit/audit.service";
import { PrismaService } from "../../common/database/prisma.service";
import { billingConfig, periodRange, previousPeriod } from "./billing-config";
import { CheckRatesService, pickRate } from "./check-rates.service";
import { issueInvoice } from "./invoices";
import { gstSplit } from "./pricing";

/** A check that cost us provider work (or a manual check with a result), not yet charged or covered. */
interface Candidate { id: string; tenantId: string; clientId: string; applicationId: string; type: string; occurredAt: Date }

const stateOf = (address: unknown) => (address && typeof address === "object" && typeof (address as { state?: unknown }).state === "string" ? (address as { state: string }).state : null);

/**
 * The billable checks that are neither charged nor covered by a prepaid package, after `since`.
 * A case on a company's seat is never billed as usage: the company pays only for the bundle it
 * bought, and checks the person adds are theirs to pay.
 * Billable: a successful provider call, or a check with no provider call that reached a result
 * (manual and field checks). Liwip Direct never pays per check.
 */
function candidates(prisma: Prisma.TransactionClient | PrismaService, since: Date, until: Date, after: string, limit: number, tenantId?: string) {
  return prisma.$queryRaw<Candidate[]>`
    SELECT * FROM (
      SELECT v."id", v."tenantId", v."clientId", v."applicationId", v."type",
        COALESCE(
          (SELECT MIN(COALESCE(pc."completedAt", pc."startedAt")) FROM "ProviderCall" pc WHERE pc."verificationId" = v."id" AND pc."state" = 'SUCCESS'),
          CASE WHEN v."status" IN ('VERIFIED', 'FAILED') AND NOT EXISTS (SELECT 1 FROM "ProviderCall" pc WHERE pc."verificationId" = v."id") THEN v."completedAt" END
        ) AS "occurredAt"
      FROM "Verification" v
      JOIN "Tenant" t ON t."id" = v."tenantId" AND t."kind" <> 'DIRECT'
      WHERE v."id" > ${after}
        ${tenantId ? Prisma.sql`AND v."tenantId" = ${tenantId}` : Prisma.empty}
        AND NOT EXISTS (SELECT 1 FROM "UsageCharge" uc WHERE uc."verificationId" = v."id")
        AND NOT EXISTS (SELECT 1 FROM "PrepaidCase" p WHERE p."applicationId" = v."applicationId" AND (p."source" = 'SEAT' OR p."coveredChecks" @> jsonb_build_array(v."type")))
    ) c
    WHERE c."occurredAt" IS NOT NULL AND c."occurredAt" >= ${since} AND c."occurredAt" < ${until}
    ORDER BY c."id"
    LIMIT ${limit}`;
}

/** Partners' API usage: each billable check is charged once at its check price, then billed monthly. */
@Injectable()
export class UsageBillingService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(UsageBillingService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CheckRatesService) private readonly rates: CheckRatesService,
    @Inject(AuditService) private readonly audit: AuditService
  ) {}

  onModuleInit() {
    if (process.env.BILLING_JOBS === "off") return;
    // Rate new checks every 15 minutes; issue last month's statements once they are due (idempotent).
    this.timer = setInterval(() => void this.rate().then(() => this.issueStatements({ period: previousPeriod() })).catch((error) => this.logger.warn(`Usage billing failed: ${(error as Error).message}`)), 15 * 60_000);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Charges every new billable check that has a price. Checks without a price wait (see unrated()). */
  async rate(now = new Date()) {
    const start = billingConfig().usageStart;
    if (!start || !Number.isFinite(start.getTime())) return { charged: 0, unrated: 0, started: false };
    const rows = await this.rates.rowsFor(null);
    const partnerRows = new Map<string, Awaited<ReturnType<CheckRatesService["rowsFor"]>>>();
    let after = "", charged = 0, unrated = 0;
    for (;;) {
      const batch = await candidates(this.prisma, start, now, after, 500);
      if (!batch.length) break;
      after = batch[batch.length - 1].id;
      const data: Prisma.UsageChargeCreateManyInput[] = [];
      for (const check of batch) {
        if (!partnerRows.has(check.tenantId)) partnerRows.set(check.tenantId, [...rows, ...(await this.prisma.checkRate.findMany({ where: { tenantId: check.tenantId } }))]);
        // The price when the check ran; a check that ran before any price existed takes today's.
        const rate = pickRate(partnerRows.get(check.tenantId)!, check.tenantId, check.type, check.occurredAt) ?? pickRate(partnerRows.get(check.tenantId)!, check.tenantId, check.type, now);
        if (!rate) { unrated++; continue; }
        data.push({ id: `uc_${randomUUID()}`, verificationId: check.id, tenantId: check.tenantId, clientId: check.clientId, applicationId: check.applicationId, checkType: check.type, checkRateId: rate.id, unitPricePaise: rate.unitPricePaise, occurredAt: check.occurredAt });
      }
      if (data.length) charged += (await this.prisma.usageCharge.createMany({ data, skipDuplicates: true })).count;
      if (batch.length < 500) break;
    }
    return { charged, unrated, started: true };
  }

  /** Billable checks in the window that have no price yet, by check type. */
  async unrated(from: Date, to: Date, tenantId?: string) {
    const start = billingConfig().usageStart;
    if (!start) return { started: false, total: 0, byCheckType: {} as Record<string, number> };
    const since = from > start ? from : start;
    const byCheckType: Record<string, number> = {};
    let after = "", total = 0;
    for (;;) {
      const batch = await candidates(this.prisma, since, to, after, 2000, tenantId);
      for (const check of batch) { byCheckType[check.type] = (byCheckType[check.type] ?? 0) + 1; total++; }
      if (batch.length < 2000) break;
      after = batch[batch.length - 1].id;
    }
    return { started: true, total, byCheckType };
  }

  /**
   * One statement per partner for the month, covering every charge up to the month's end that is
   * not on a statement yet (a check charged late rolls into the next statement). A partner that
   * already has this month's statement is skipped, so running it twice is safe.
   */
  async issueStatements(input: { period: string; tenantId?: string; createdById?: string }) {
    const { to } = periodRange(input.period);
    if (to > new Date()) throw new BadRequestException(`${input.period} has not ended yet`);
    const tenants = await this.prisma.usageCharge.groupBy({ by: ["tenantId"], where: { statementId: null, occurredAt: { lt: to }, ...(input.tenantId ? { tenantId: input.tenantId } : {}) } });
    const issued: string[] = [];
    for (const { tenantId } of tenants) {
      const id = await this.issueOne(tenantId, input.period, to, input.createdById).catch((error) => {
        if ((error as Prisma.PrismaClientKnownRequestError).code === "P2002") return null;
        throw error;
      });
      if (id) issued.push(id);
    }
    return { period: input.period, issued: issued.length, statementIds: issued };
  }

  private async issueOne(tenantId: string, period: string, to: Date, createdById?: string) {
    const config = billingConfig();
    const statementId = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`usage-statement:${tenantId}`}))`;
      const charges = await tx.usageCharge.findMany({ where: { tenantId, statementId: null, occurredAt: { lt: to } }, select: { id: true, checkType: true, unitPricePaise: true } });
      if (!charges.length) return null;
      const grouped = new Map<string, { checkType: string; count: number; unitPricePaise: number; amountPaise: number }>();
      for (const charge of charges) {
        const key = `${charge.checkType}:${charge.unitPricePaise}`;
        const line = grouped.get(key) ?? { checkType: charge.checkType, count: 0, unitPricePaise: charge.unitPricePaise, amountPaise: 0 };
        line.count++; line.amountPaise += charge.unitPricePaise;
        grouped.set(key, line);
      }
      const lines = [...grouped.values()].sort((a, b) => a.checkType.localeCompare(b.checkType) || a.unitPricePaise - b.unitPricePaise);
      const taxablePaise = lines.reduce((sum, line) => sum + line.amountPaise, 0);
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { address: true } });
      const tax = gstSplit(taxablePaise, { rateBps: config.gstRateBps, sellerState: config.sellerState, buyerState: stateOf(tenant.address) });
      const statement = await tx.usageStatement.create({
        data: {
          id: `stmt_${randomUUID()}`, tenantId, period, lines, checkCount: charges.length, taxablePaise,
          cgstPaise: tax.cgstPaise, sgstPaise: tax.sgstPaise, igstPaise: tax.igstPaise, totalPaise: taxablePaise + tax.gstPaise,
          dueAt: new Date(Date.now() + config.statementDueDays * 86_400_000), createdById: createdById ?? null
        }
      });
      const claimed = await tx.usageCharge.updateMany({ where: { id: { in: charges.map((charge) => charge.id) }, statementId: null }, data: { statementId: statement.id } });
      if (claimed.count !== charges.length) throw new ConflictException("Charges changed while the statement was issued; try again");
      await issueInvoice(tx, { statementId: statement.id, tenantId, individual: false, taxablePaise, cgstPaise: tax.cgstPaise, sgstPaise: tax.sgstPaise, igstPaise: tax.igstPaise, totalPaise: statement.totalPaise });
      return statement.id;
    });
    if (statementId) this.audit.record({ actorType: createdById ? "STAFF" : "SYSTEM", actorUserId: createdById, tenantId, action: "statements.issue", outcome: "SUCCESS", resourceType: "UsageStatement", resourceId: statementId, metadata: { period } });
    return statementId;
  }

  async markPaid(input: { statementId: string; reference: string; paidAt?: Date | null }) {
    const reference = input.reference.trim();
    if (reference.length < 4 || reference.length > 120) throw new BadRequestException("Give the payment reference (4 to 120 characters)");
    const updated = await this.prisma.usageStatement.updateMany({ where: { id: input.statementId, status: "ISSUED" }, data: { status: "PAID", paidAt: input.paidAt ?? new Date(), paymentReference: reference } });
    if (!updated.count) {
      const statement = await this.prisma.usageStatement.findUnique({ where: { id: input.statementId }, select: { status: true } });
      if (!statement) throw new NotFoundException("Statement not found");
      throw new ConflictException(`This statement is ${statement.status.toLowerCase()}`);
    }
    return this.get(input.statementId);
  }

  async list(where: { tenantId?: string; status?: string; period?: string }, page: { skip: number; limit: number }) {
    // OVERDUE is ISSUED past its due date.
    const status = where.status === "OVERDUE" ? { status: "ISSUED", dueAt: { lt: new Date() } } : where.status ? { status: where.status } : {};
    const filter: Prisma.UsageStatementWhereInput = { ...(where.tenantId ? { tenantId: where.tenantId } : {}), ...status, ...(where.period ? { period: where.period } : {}) };
    const [rows, total] = await Promise.all([
      this.prisma.usageStatement.findMany({ where: filter, orderBy: [{ period: "desc" }, { issuedAt: "desc" }], skip: page.skip, take: page.limit, include: { invoice: true, tenant: { select: { name: true } } } }),
      this.prisma.usageStatement.count({ where: filter })
    ]);
    return { rows: rows.map(statementView), total };
  }

  async get(statementId: string, tenantId?: string) {
    const row = await this.prisma.usageStatement.findFirst({ where: { id: statementId, ...(tenantId ? { tenantId } : {}) }, include: { invoice: true, tenant: { select: { name: true } } } });
    if (!row) throw new NotFoundException("Statement not found");
    return statementView(row);
  }
}

type StatementRow = Prisma.UsageStatementGetPayload<{ include: { invoice: true; tenant: { select: { name: true } } } }>;

export function statementView(row: StatementRow) {
  const overdue = row.status === "ISSUED" && row.dueAt < new Date();
  return {
    id: row.id, partner: { id: row.tenantId, name: row.tenant.name }, period: row.period, status: overdue ? "OVERDUE" : row.status, lines: row.lines, checkCount: row.checkCount,
    taxablePaise: row.taxablePaise, cgstPaise: row.cgstPaise, sgstPaise: row.sgstPaise, igstPaise: row.igstPaise, totalPaise: row.totalPaise,
    issuedAt: row.issuedAt, dueAt: row.dueAt, paidAt: row.paidAt, paymentReference: row.paymentReference,
    invoice: row.invoice ? { number: row.invoice.number, issuedAt: row.invoice.issuedAt } : null
  };
}
