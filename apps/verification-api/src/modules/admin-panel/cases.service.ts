import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../common/database/prisma.service";
import { AdminContext, partnerDb } from "../admin-access/admin-context";
import { hasPermission } from "../admin-access/admin-permissions";
import { categoryOf, checkState, latestChecks, photoDataUrl, workerName } from "../cards/card-views";
import { BGV_MODULES, VEHICLE_CHECK_TYPES, moduleOf, modulesOf, subjectOf } from "../../domain/modules";
import { DocumentStorageService } from "../document-storage/document-storage.service";
import { VerificationStore } from "../verifications/verification.repository";
import { Page, maskPhone, oneOf, optionalDate, optionalText, paginated, text } from "./input";

const STATES = ["DRAFT", "PENDING_VERIFICATION", "VERIFICATION_IN_PROGRESS", "VERIFIED", "VERIFICATION_FAILED", "MANUAL_REVIEW"] as const;

export interface CaseListQuery {
  search?: string; state?: string; package?: string; checkType?: string; module?: string; programId?: string; relationship?: string; from?: string; to?: string;
}

const CASE_INCLUDE = {
  tenant: { select: { id: true, name: true, slug: true } },
  client: { select: { id: true, name: true, code: true } },
  package: { select: { code: true, name: true, version: true } },
  verificationCard: { select: { id: true, cardNumber: true, status: true, issuedAt: true, expiresAt: true } },
  verifications: { select: { id: true, type: true, status: true, attemptCount: true, failureCode: true, failureReason: true, createdAt: true, startedAt: true, completedAt: true, updatedAt: true }, orderBy: { createdAt: "asc" as const } }
} satisfies Prisma.ApplicationInclude;

type CaseRow = Prisma.ApplicationGetPayload<{ include: typeof CASE_INCLUDE }>;
type CheckRow = CaseRow["verifications"][number];

/** The case as the partner saw it when the worker left. */
export interface RelationshipSnapshot {
  capturedAt: string;
  status: string;
  worker: { name: string | null; phoneLast4: string | null };
  package: { code: string; name: string; version: number } | null;
  checks: Array<{ id: string; type: string; status: string; attemptCount: number; failureCode: string | null; failureReason: string | null; createdAt: string; startedAt: string | null; completedAt: string | null; updatedAt: string }>;
  checkTypes: string[];
  /** The vehicle on the case when the relationship ended (absent in snapshots taken before modules). */
  vehicle?: { registrationNumber: string | null } | null;
  card: { cardNumber: string; status: string; issuedAt: string; expiresAt: string } | null;
  updatedAt: string;
}

const iso = (value: Date | null | undefined) => value?.toISOString() ?? null;

const checkView = (check: { id: string; type: string; status: string; attemptCount: number; failureCode: string | null; failureReason: string | null; startedAt: string | null; completedAt: string | null; updatedAt: string }) => ({
  id: check.id,
  type: check.type,
  module: moduleOf(check.type),
  category: categoryOf(check.type),
  status: check.status,
  state: checkState(check.status),
  attemptCount: check.attemptCount,
  failureCode: check.failureCode,
  failureReason: check.failureReason,
  startedAt: check.startedAt,
  completedAt: check.completedAt,
  updatedAt: check.updatedAt
});

const serialiseCheck = (check: CheckRow) => ({
  id: check.id, type: check.type, status: check.status, attemptCount: check.attemptCount, failureCode: check.failureCode, failureReason: check.failureReason,
  createdAt: check.createdAt.toISOString(), startedAt: iso(check.startedAt), completedAt: iso(check.completedAt), updatedAt: check.updatedAt.toISOString()
});

/** The subject as it was at the relationship end; older snapshots have no vehicle number. */
function snapshotSubject(snapshot: RelationshipSnapshot) {
  const modules = modulesOf(snapshot.checkTypes);
  return { person: modules.includes("PEOPLE"), vehicle: modules.includes("VEHICLE") ? (snapshot.vehicle ?? { registrationNumber: null }) : null };
}

function summarise(checks: Array<{ status: string }>) {
  const count = (state: string) => checks.filter((check) => checkState(check.status) === state).length;
  return { total: checks.length, clear: count("CLEAR"), needsReview: count("NEEDS_REVIEW"), discrepancy: count("DISCREPANCY"), inProgress: count("IN_PROGRESS"), waiting: count("WAITING") };
}

export function buildSnapshot(row: CaseRow, now = new Date()): RelationshipSnapshot {
  const checks = latestChecks(row.verifications).map(serialiseCheck);
  const card = row.verificationCard;
  return {
    capturedAt: now.toISOString(),
    status: row.status,
    worker: { name: workerName(row.data), phoneLast4: maskPhone(row.workerPhone) },
    package: row.package ? { code: row.package.code, name: row.package.name, version: row.package.version } : null,
    checks,
    checkTypes: [...new Set(checks.map((check) => check.type))],
    vehicle: subjectOf(checks.map((check) => check.type), row.data).vehicle,
    card: card ? { cardNumber: card.cardNumber, status: card.status, issuedAt: card.issuedAt.toISOString(), expiresAt: card.expiresAt.toISOString() } : null,
    updatedAt: row.updatedAt.toISOString()
  };
}

/**
 * Case read APIs for the admin panel. Partner staff read through the scoped client;
 * Keystone staff read one partner (x-partner-id) or every partner.
 *
 * Relationship end: when a worker leaves a partner, partner staff keep the case as it
 * was at the end date (a snapshot taken then) and see none of the later activity.
 * Keystone staff always see the live case.
 */
@Injectable()
export class CasesService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(DocumentStorageService) private readonly documents: DocumentStorageService,
    @Inject(VerificationStore) private readonly store: VerificationStore
  ) {}

  /** True when the viewer only reaches cases through partner bindings, so ended relationships are frozen. */
  frozen(admin: AdminContext): boolean {
    return !hasPermission(admin.bindings, "cases.read", { kind: "ALL_PARTNERS" });
  }

  async list(admin: AdminContext, query: CaseListQuery, page: Page) {
    const db = partnerDb(this.prisma, admin);
    const frozen = this.frozen(admin);
    const and: Prisma.ApplicationWhereInput[] = [{ status: { not: "ARCHIVED" } }];
    if (query.state) {
      const state = oneOf(query.state, "state", STATES);
      and.push(frozen ? { OR: [{ relationshipStatus: "ACTIVE", status: state }, { relationshipStatus: "ENDED", relationshipEndStatus: state }] } : { status: state });
    }
    if (query.package) and.push({ package: { code: text(query.package, "package", 80).toUpperCase() } });
    if (query.checkType) {
      const type = text(query.checkType, "checkType", 40).toUpperCase();
      and.push(frozen
        ? { OR: [{ relationshipStatus: "ACTIVE", verifications: { some: { type } } }, { relationshipStatus: "ENDED", relationshipSnapshot: { path: ["checkTypes"], array_contains: [type] } }] }
        : { verifications: { some: { type } } });
    }
    if (query.module) {
      // A module is on the case when any of its checks is.
      const module = oneOf(query.module, "module", BGV_MODULES);
      const types = { in: [...VEHICLE_CHECK_TYPES] };
      const live: Prisma.ApplicationWhereInput = { verifications: { some: { type: module === "VEHICLE" ? types : { notIn: types.in } } } };
      // Ended cases keep their check types in JSON, where "some type outside the list" cannot be asked: each counts as People.
      const ended: Prisma.ApplicationWhereInput = module === "VEHICLE"
        ? { OR: VEHICLE_CHECK_TYPES.map((type) => ({ relationshipSnapshot: { path: ["checkTypes"], array_contains: [type] } })) }
        : {};
      and.push(frozen ? { OR: [{ relationshipStatus: "ACTIVE", ...live }, { relationshipStatus: "ENDED", ...ended }] } : live);
    }
    if (query.programId) and.push({ clientId: text(query.programId, "programId", 100) });
    if (query.relationship) and.push({ relationshipStatus: oneOf(query.relationship, "relationship", ["ACTIVE", "ENDED"] as const) });
    const from = optionalDate(query.from, "from");
    const to = optionalDate(query.to, "to");
    if (from) and.push({ createdAt: { gte: from } });
    if (to) and.push({ createdAt: { lt: to } });
    const search = query.search?.trim().slice(0, 80);
    if (search) {
      const digits = search.replace(/\D/g, "");
      const or: Prisma.ApplicationWhereInput[] = [
        { id: search },
        { cardNumber: { contains: search.toUpperCase() } },
        { data: { path: ["identity", "fullName"], string_contains: search } },
        { data: { path: ["personal", "declaredName"], string_contains: search } },
        { data: { path: ["personal", "nameAsAadhaar"], string_contains: search } }
      ];
      if (/^(\+?91)?[6-9]\d{9}$/.test(search.replace(/[\s-]/g, ""))) or.push({ workerPhone: `91${digits.slice(-10)}` });
      const vehicleNumber = search.toUpperCase().replace(/[\s-]/g, "");
      if (/^[A-Z0-9]{6,12}$/.test(vehicleNumber) && /\d/.test(vehicleNumber) && /[A-Z]/.test(vehicleNumber)) or.push({ data: { path: ["vehicle", "registrationNumber"], equals: vehicleNumber } });
      and.push({ OR: or });
    }
    const where: Prisma.ApplicationWhereInput = { AND: and };
    const [rows, total] = await Promise.all([
      db.application.findMany({ where, include: CASE_INCLUDE, orderBy: { createdAt: "desc" }, skip: page.skip, take: page.limit }),
      db.application.count({ where })
    ]);
    return paginated(rows.map((row) => this.listItem(row as CaseRow, frozen)), total, page);
  }

  private listItem(row: CaseRow, frozen: boolean) {
    const snapshot = frozen && row.relationshipStatus === "ENDED" ? (row.relationshipSnapshot as unknown as RelationshipSnapshot) : null;
    const checks = snapshot ? snapshot.checks : latestChecks(row.verifications);
    const card = snapshot ? snapshot.card : row.verificationCard;
    return {
      id: row.id,
      partner: { id: row.tenant.id, name: row.tenant.name },
      program: { id: row.client.id, name: row.client.name },
      worker: snapshot ? snapshot.worker : { name: workerName(row.data), phoneLast4: maskPhone(row.workerPhone) },
      status: snapshot ? snapshot.status : row.status,
      package: snapshot ? snapshot.package : row.package,
      modules: modulesOf(checks.map((check) => check.type)),
      subject: snapshot ? snapshotSubject(snapshot) : subjectOf(checks.map((check) => check.type), row.data),
      checks: summarise(checks),
      card: card ? { cardNumber: card.cardNumber, status: card.status } : null,
      relationship: { status: row.relationshipStatus, endedAt: iso(row.relationshipEndedAt) },
      createdAt: row.createdAt.toISOString(),
      updatedAt: snapshot ? snapshot.updatedAt : row.updatedAt.toISOString()
    };
  }

  private async load(admin: AdminContext, caseId: string): Promise<CaseRow> {
    const row = await partnerDb(this.prisma, admin).application.findFirst({ where: { id: caseId, status: { not: "ARCHIVED" } }, include: CASE_INCLUDE });
    if (!row) throw new NotFoundException("Case not found");
    admin.audit = { ...admin.audit, tenantId: row.tenantId, clientId: row.clientId, resourceType: "Application", resourceId: row.id };
    return row as CaseRow;
  }

  /** The moment after which a partner viewer sees nothing, or null for a live view. */
  private cutoff(admin: AdminContext, row: CaseRow): Date | null {
    return this.frozen(admin) && row.relationshipStatus === "ENDED" ? row.relationshipEndedAt : null;
  }

  async detail(admin: AdminContext, caseId: string) {
    const row = await this.load(admin, caseId);
    const cutoff = this.cutoff(admin, row);
    const snapshot = cutoff ? (row.relationshipSnapshot as unknown as RelationshipSnapshot) : null;
    const db = partnerDb(this.prisma, admin);
    const before = cutoff ? { lte: cutoff } : undefined;
    const [documents, photo, audit] = await Promise.all([
      db.applicationDocument.findMany({
        where: { applicationId: row.id, deletedAt: null, ...(before ? { createdAt: before } : {}) },
        orderBy: { createdAt: "asc" },
        select: { id: true, documentType: true, originalFileName: true, contentType: true, sizeBytes: true, status: true, uploadedAt: true, createdAt: true }
      }),
      this.photo(admin, row, cutoff),
      db.auditLog.findMany({
        where: { resourceId: row.id, tenantId: row.tenantId, ...(before ? { createdAt: before } : {}) },
        orderBy: { createdAt: "desc" },
        take: 200,
        select: { id: true, actorType: true, actorUserId: true, action: true, outcome: true, statusCode: true, message: true, createdAt: true }
      })
    ]);
    const checks = snapshot ? snapshot.checks : latestChecks(row.verifications).map(serialiseCheck);
    const card = snapshot ? snapshot.card : row.verificationCard && { cardNumber: row.verificationCard.cardNumber, status: row.verificationCard.status, issuedAt: row.verificationCard.issuedAt.toISOString(), expiresAt: row.verificationCard.expiresAt.toISOString() };
    const data = (row.data ?? {}) as { personal?: { declaredName?: string; nameAsAadhaar?: string }; identity?: { fullName?: string; status?: string } };
    return {
      id: row.id,
      view: snapshot ? "AS_OF_RELATIONSHIP_END" : "LIVE",
      partner: { id: row.tenant.id, name: row.tenant.name },
      program: row.client,
      status: snapshot ? snapshot.status : row.status,
      package: snapshot ? snapshot.package : row.package,
      worker: snapshot
        ? { ...snapshot.worker, identityVerified: null }
        : { name: workerName(row.data), declaredName: data.personal?.declaredName ?? null, phoneLast4: maskPhone(row.workerPhone), identityVerified: data.identity?.status === "VERIFIED" },
      photo,
      subject: snapshot ? snapshotSubject(snapshot) : subjectOf(checks.map((check) => check.type), row.data),
      checks: checks.map(checkView),
      checkSummary: summarise(checks),
      // The report's sections: each module's checks and how they stand.
      modules: modulesOf(checks.map((check) => check.type)).map((module) => {
        const own = checks.filter((check) => moduleOf(check.type) === module);
        return { module, checkIds: own.map((check) => check.id), summary: summarise(own) };
      }),
      documents: documents.map((document) => ({ ...document, uploadedAt: iso(document.uploadedAt), createdAt: document.createdAt.toISOString() })),
      card,
      relationship: { status: row.relationshipStatus, endedAt: iso(row.relationshipEndedAt), reason: row.relationshipEndReason },
      timeline: this.timeline(row, checks, audit, cutoff),
      createdAt: row.createdAt.toISOString(),
      updatedAt: snapshot ? snapshot.updatedAt : row.updatedAt.toISOString()
    };
  }

  /** Case lifecycle events plus every audited action on the case, newest first. */
  private timeline(row: CaseRow, checks: ReturnType<typeof serialiseCheck>[], audit: Array<{ id: string; actorType: string; actorUserId: string | null; action: string; outcome: string; statusCode: number | null; message: string | null; createdAt: Date }>, cutoff: Date | null) {
    const events: Array<{ at: string; kind: string; action: string; actorType: string | null; actorUserId: string | null; outcome: string | null; detail: string | null }> = [
      { at: row.createdAt.toISOString(), kind: "CASE", action: "case.opened", actorType: null, actorUserId: null, outcome: null, detail: null }
    ];
    for (const check of checks) {
      if (check.completedAt) events.push({ at: check.completedAt, kind: "CHECK", action: `check.${checkState(check.status).toLowerCase()}`, actorType: null, actorUserId: null, outcome: check.status, detail: check.type });
    }
    if (row.verificationCard && (!cutoff || row.verificationCard.issuedAt <= cutoff)) events.push({ at: row.verificationCard.issuedAt.toISOString(), kind: "CARD", action: "card.issued", actorType: null, actorUserId: null, outcome: null, detail: null });
    if (row.relationshipEndedAt) events.push({ at: row.relationshipEndedAt.toISOString(), kind: "RELATIONSHIP", action: "relationship.ended", actorType: "STAFF", actorUserId: row.relationshipEndedById, outcome: null, detail: row.relationshipEndReason });
    for (const entry of audit) events.push({ at: entry.createdAt.toISOString(), kind: "AUDIT", action: entry.action, actorType: entry.actorType, actorUserId: entry.actorUserId, outcome: entry.outcome, detail: entry.message });
    return events.sort((a, b) => b.at.localeCompare(a.at));
  }

  private async photo(admin: AdminContext, row: CaseRow, cutoff: Date | null) {
    const db = partnerDb(this.prisma, admin);
    const where = { applicationId: row.id, ...(cutoff ? { createdAt: { lte: cutoff } } : {}) };
    const photo = (await db.workerPhoto.findFirst({ where })) ?? (await db.aadhaarPhoto.findFirst({ where }));
    return photoDataUrl(photo);
  }

  /** A short-lived signed S3 URL for one document of the case. */
  async documentUrl(admin: AdminContext, caseId: string, documentId: string) {
    const row = await this.load(admin, caseId);
    const cutoff = this.cutoff(admin, row);
    const document = await partnerDb(this.prisma, admin).applicationDocument.findFirst({ where: { id: documentId, applicationId: row.id, ...(cutoff ? { createdAt: { lte: cutoff } } : {}) }, select: { id: true } });
    if (!document) throw new NotFoundException("Document not found");
    admin.audit = { ...admin.audit, resourceType: "ApplicationDocument", resourceId: document.id, metadata: { caseId: row.id } };
    return this.documents.createDownloadUrl(row.id, document.id, { tenantId: row.tenantId, clientId: row.clientId });
  }

  /** The worker left the partner: freeze what the partner sees. The worker's card stays valid. */
  async endRelationship(admin: AdminContext, caseId: string, input: { reason?: unknown }) {
    const row = await this.load(admin, caseId);
    if (row.relationshipStatus === "ENDED") throw new ConflictException("This worker's relationship has already ended");
    const reason = optionalText(input.reason, "reason", 300) ?? null;
    // Ends now: what the partner already saw stays theirs; nothing after this moment is shown.
    const now = new Date();
    const changed = await partnerDb(this.prisma, admin).application.updateMany({
      where: { id: row.id, relationshipStatus: "ACTIVE" },
      data: {
        relationshipStatus: "ENDED",
        relationshipEndedAt: now,
        relationshipEndReason: reason,
        relationshipEndStatus: row.status,
        relationshipSnapshot: buildSnapshot(row, now) as unknown as Prisma.InputJsonValue,
        relationshipEndedById: admin.user.id
      }
    });
    if (changed.count !== 1) throw new ConflictException("This worker's relationship has already ended");
    admin.audit = { ...admin.audit, metadata: { reason } };
    return { id: row.id, relationship: { status: "ENDED", endedAt: now.toISOString(), reason } };
  }

  /** A reviewer's decision on a check in review. */
  async decide(admin: AdminContext, caseId: string, checkId: string, input: { decision?: unknown; note?: unknown }) {
    const row = await this.load(admin, caseId);
    const decision = oneOf(input.decision, "decision", ["VERIFIED", "FAILED"] as const);
    const note = optionalText(input.note, "note", 300) ?? null;
    const decided = await partnerDb(this.prisma, admin).verification.updateMany({
      where: { id: checkId, applicationId: row.id, status: "MANUAL_REVIEW" },
      data: decision === "VERIFIED"
        ? { status: "VERIFIED", failureCode: null, failureReason: null, completedAt: new Date() }
        : { status: "FAILED", failureCode: "REVIEW_REJECTED", failureReason: note ?? "Rejected in review", completedAt: new Date() }
    });
    if (!decided.count) throw new NotFoundException("No check in review with this id");
    const updated = await this.store.recalculateApplicationStatus(row.id, { tenantId: row.tenantId, clientId: row.clientId });
    admin.audit = { ...admin.audit, metadata: { checkId, decision, note } };
    return { id: row.id, checkId, decision, status: updated.status, cardIssued: Boolean(updated.card) };
  }
}
