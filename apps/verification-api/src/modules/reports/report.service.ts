import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../common/database/prisma.service";
import type { ApplicationOwner } from "../../domain/verification.types";
import { AdminContext, partnerDb } from "../admin-access/admin-context";
import { hasPermission } from "../admin-access/admin-permissions";
import type { RelationshipSnapshot } from "../admin-panel/cases.service";
import { VerificationStore } from "../verifications/verification.repository";
import { buildCaseReport, ReportInput } from "./case-report";

const REPORT_INCLUDE = {
  tenant: { select: { id: true, name: true } },
  client: { select: { id: true, name: true } },
  package: { select: { code: true, name: true, version: true, checks: true } },
  verificationCard: { select: { cardNumber: true, status: true, issuedAt: true, expiresAt: true } },
  verifications: {
    select: {
      id: true, type: true, status: true, failureReason: true, result: true, createdAt: true, completedAt: true, updatedAt: true,
      fieldTask: { select: { outcome: true, submittedAt: true, _count: { select: { evidence: { where: { deletedAt: null } } } } } }
    },
    orderBy: { createdAt: "asc" as const }
  }
} satisfies Prisma.ApplicationInclude;

type ReportRow = Prisma.ApplicationGetPayload<{ include: typeof REPORT_INCLUDE }>;

/** The JSON case report, for the partner API and the admin apps. */
@Injectable()
export class ReportService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(VerificationStore) private readonly store: VerificationStore
  ) {}

  /** Through an API key: only a case that key may read (the same rule as its other case routes). */
  async forApiKey(applicationId: string, owner: ApplicationOwner) {
    if (!(await this.store.getApplication(applicationId, owner))) throw new NotFoundException(`Application ${applicationId} not found`);
    const row = await this.prisma.application.findFirstOrThrow({ where: { id: applicationId, tenantId: owner.tenantId, clientId: owner.clientId }, include: REPORT_INCLUDE });
    return buildCaseReport(this.input(row));
  }

  /** Admin apps. A partner sees a case whose relationship ended as it was on that day. */
  async forAdmin(admin: AdminContext, caseId: string) {
    const row = await partnerDb(this.prisma, admin).application.findFirst({ where: { id: caseId, status: { not: "ARCHIVED" } }, include: REPORT_INCLUDE }) as ReportRow | null;
    if (!row) throw new NotFoundException("Case not found");
    admin.audit = { ...admin.audit, tenantId: row.tenantId, clientId: row.clientId, resourceType: "Application", resourceId: row.id };
    const frozen = !hasPermission(admin.bindings, "cases.read", { kind: "ALL_PARTNERS" }) && row.relationshipStatus === "ENDED";
    if (!frozen) return buildCaseReport(this.input(row));
    const snapshot = row.relationshipSnapshot as unknown as RelationshipSnapshot;
    return buildCaseReport({
      ...this.input(row),
      status: snapshot.status,
      checks: snapshot.checks,
      card: snapshot.card,
      // The person and vehicle as the snapshot recorded them.
      data: { personal: { nameAsAadhaar: snapshot.worker.name ?? undefined }, vehicle: snapshot.vehicle ?? undefined },
      finalResultAt: row.finalResultAt && row.relationshipEndedAt && row.finalResultAt <= row.relationshipEndedAt ? row.finalResultAt : null,
      asOf: row.relationshipEndedAt
    });
  }

  private input(row: ReportRow): ReportInput {
    return {
      id: row.id, status: row.status, createdAt: row.createdAt, finalResultAt: row.finalResultAt,
      partner: row.tenant, program: row.client, package: row.package, data: row.data, workerPhone: row.workerPhone, card: row.verificationCard,
      checks: row.verifications.map(({ fieldTask, ...check }) => ({
        ...check,
        fieldVisit: fieldTask ? { outcome: fieldTask.outcome, submittedAt: fieldTask.submittedAt, evidenceCount: fieldTask._count.evidence } : null
      }))
    };
  }
}
