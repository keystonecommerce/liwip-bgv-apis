import { applicationStatusForChecks } from "../../domain/application-status";
import { withTenantScope } from "../../common/database/tenant-prisma";
import { Inject, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import {
  ApplicationRecord,
  ApplicationOwner,
  ApplicationSchema,
  ApplicationStatus,
  FinalRecommendation,
  PackageCheckRule,
  SensitiveVerificationInputs,
  VerificationRecord,
  VerificationPackageKind,
  VerificationPackageRecord,
  VerificationStatus,
  VerificationCardRecord,
  VerificationType
} from "../../domain/verification.types";
import { PrismaService } from "../../common/database/prisma.service";

type StoredApplication = {
  apiKeyId?: string | null;
  id: string;
  tenantId: string;
  clientId: string;
  packageId: string | null;
  status: string;
  workerPhone?: string | null;
  data: unknown;
  createdAt: Date;
  updatedAt: Date;
  package?: StoredPackage | null;
  verifications?: Array<{ id: string }>;
  verificationCard?: StoredVerificationCard | null;
};

type StoredVerificationCard = {
  id: string;
  applicationId: string;
  cardNumber: string;
  publicId: string;
  status: string;
  issuedAt: Date;
  expiresAt: Date;
};

type StoredPackage = {
  id: string;
  code: string;
  version: number;
  name: string;
  description: string | null;
  kind: string;
  priceInr: number | null;
  advertisedCheckCount: number | null;
  targetWorkforce: string | null;
  displayOrder: number;
  isActive: boolean;
  checks: unknown;
  createdAt: Date;
  updatedAt: Date;
};

type StoredVerification = {
  id: string;
  applicationId: string;
  type: string;
  status: string;
  provider: string;
  attemptCount: number;
  providerRequestId: string | null;
  result: unknown;
  failureResponse: unknown;
  failureCode: string | null;
  failureReason: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  updatedAt: Date;
};

// Waiting on the worker or still running. A check in review does not hold the card back.
const UNFINISHED = new Set(["PENDING", "QUEUED", "PROCESSING"]);

/**
 * True once every chosen check has been attempted (passed, failed or in review), Aadhaar
 * passed (if chosen) and at least one check passed. Checks in review join the card when
 * a reviewer approves them; until then the card shows as updating.
 */
export function workerCardReady(checks: Array<{ status: string; type: string }>): boolean {
  if (!checks.length || checks.some((check) => UNFINISHED.has(check.status))) return false;
  const aadhaar = checks.find((check) => check.type === "AADHAAR");
  if (aadhaar && aadhaar.status !== "VERIFIED") return false;
  return checks.some((check) => check.status === "VERIFIED");
}

function newCard(applicationId: string, owner: ApplicationOwner, cardNumber: string | null) {
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt);
  expiresAt.setUTCFullYear(expiresAt.getUTCFullYear() + 1);
  return { id: `card_${randomUUID()}`, applicationId, tenantId: owner.tenantId, clientId: owner.clientId, cardNumber: cardNumber ?? newCardNumber(issuedAt), publicId: randomUUID(), status: "ACTIVE", issuedAt, expiresAt };
}

/** Liwip BGV Card number. Format is a placeholder until product confirms it. */
export const newCardNumber = (at = new Date()) => `LIWIP-${at.getUTCFullYear()}-${randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`;

const asInputJson = (value: unknown): Prisma.InputJsonValue => value as Prisma.InputJsonValue;
const asNullableJson = (value: unknown): Prisma.InputJsonValue | Prisma.NullTypes.DbNull =>
  value === undefined || value === null ? Prisma.DbNull : asInputJson(value);

@Injectable()
export class VerificationStore {
  private readonly sensitiveInputs = new Map<string, SensitiveVerificationInputs>();

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async createApplication(
    data: ApplicationSchema,
    types: VerificationType[],
    verificationPackage: VerificationPackageRecord,
    owner: ApplicationOwner
  ): Promise<ApplicationRecord> {
    const now = new Date();
    const applicationId = `app_${randomUUID()}`;
    const verificationIds = types.map(() => `verification_${randomUUID()}`);
    const provider = process.env.VERIFICATION_PROVIDER || "surepass";

    await this.prisma.$transaction(async (transaction) => {
      await transaction.application.create({
        data: {
          id: applicationId,
          apiKeyId: owner.apiKeyId,
          tenantId: owner.tenantId,
          clientId: owner.clientId,
          packageId: verificationPackage.id,
          status: types.length ? "PENDING_VERIFICATION" : "VERIFIED",
          data: asInputJson(data),
          createdAt: now,
          updatedAt: now
        }
      });

      if (types.length) {
        await transaction.verification.createMany({
          data: types.map((type, index) => ({
            id: verificationIds[index],
            applicationId,
            tenantId: owner.tenantId,
            clientId: owner.clientId,
            type,
            status: "QUEUED",
            provider,
            attemptCount: 0,
            createdAt: now,
            updatedAt: now
          }))
        });
      }
    });

    return {
      id: applicationId,
      tenantId: owner.tenantId,
      clientId: owner.clientId,
      packageId: verificationPackage.id,
      package: {
        id: verificationPackage.id,
        code: verificationPackage.code,
        version: verificationPackage.version,
        name: verificationPackage.name,
        kind: verificationPackage.kind,
        priceInr: verificationPackage.priceInr,
        advertisedCheckCount: verificationPackage.advertisedCheckCount
      },
      status: types.length ? "PENDING_VERIFICATION" : "VERIFIED",
      recommendation: types.length ? "PENDING" : "PASS",
      data,
      verificationIds,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString()
    };
  }

  async getApplication(id: string, owner?: ApplicationOwner): Promise<ApplicationRecord | undefined> {
    const application = await (owner ? withTenantScope(this.prisma, owner) : this.prisma).application.findFirst({
      where: { id, ...(owner ? { tenantId: owner.tenantId, clientId: owner.clientId } : {}) },
      include: { package: true, verificationCard: true, verifications: { select: { id: true }, orderBy: { createdAt: "asc" } } }
    });
    return application ? this.mapApplication(application) : undefined;
  }

  async getVerification(id: string, owner?: ApplicationOwner): Promise<VerificationRecord | undefined> {
    const verification = await (owner ? withTenantScope(this.prisma, owner) : this.prisma).verification.findFirst({
      where: { id, ...(owner ? { application: { tenantId: owner.tenantId, clientId: owner.clientId } } : {}) }
    });
    return verification ? this.mapVerification(verification) : undefined;
  }

  async createSupplementaryVerification(id: string, applicationId: string, type: VerificationType, provider: string, fingerprint: string): Promise<{ created: boolean; verification: VerificationRecord }> {
    const owner = await this.prisma.application.findUniqueOrThrow({ where: { id: applicationId }, select: { tenantId: true, clientId: true } });
    try {
      const record = await this.prisma.verification.create({ data: {
        id, applicationId, tenantId: owner.tenantId, clientId: owner.clientId, type, provider, status: "PROCESSING", attemptCount: 1,
        startedAt: new Date(), result: { requestFingerprint: fingerprint }
      } });
      return { created: true, verification: this.mapVerification(record) };
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
      const existing = await this.prisma.verification.findUnique({ where: { id } });
      if (!existing) throw error;
      return { created: false, verification: this.mapVerification(existing) };
    }
  }

  async getVerificationsForApplication(applicationId: string, owner?: ApplicationOwner): Promise<VerificationRecord[]> {
    const verifications = await (owner ? withTenantScope(this.prisma, owner) : this.prisma).verification.findMany({
      where: { applicationId, ...(owner ? { application: { tenantId: owner.tenantId, clientId: owner.clientId } } : {}) },
      orderBy: { createdAt: "asc" }
    });
    return verifications.map((verification) => this.mapVerification(verification));
  }

  setSensitiveInputs(applicationId: string, inputs: SensitiveVerificationInputs): void {
    this.sensitiveInputs.set(applicationId, inputs);
  }

  getSensitiveInputs(applicationId: string): SensitiveVerificationInputs | undefined {
    return this.sensitiveInputs.get(applicationId);
  }

  clearSensitiveInputs(applicationId: string): void {
    this.sensitiveInputs.delete(applicationId);
  }

  /**
   * A worker's selfie and Aadhaar reference photo, from the database. Memory only holds them
   * on the instance that took the upload; during a deploy another instance can run the job.
   */
  async workerFaceInputs(applicationId: string): Promise<SensitiveVerificationInputs | undefined> {
    const [selfie, reference] = await Promise.all([
      this.prisma.workerPhoto.findUnique({ where: { applicationId } }),
      this.prisma.aadhaarPhoto.findUnique({ where: { applicationId } })
    ]);
    if (!selfie) return undefined;
    return {
      selfie: { buffer: Buffer.from(selfie.bytes), originalname: "selfie.jpg", mimetype: selfie.contentType },
      ...(reference ? { idCard: { buffer: Buffer.from(reference.bytes), originalname: "aadhaar-photo.jpg", mimetype: reference.contentType } } : {})
    };
  }

  async updateVerification(id: string, patch: Partial<VerificationRecord>, owner?: ApplicationOwner): Promise<VerificationRecord> {
    const data: Prisma.VerificationUpdateInput = { updatedAt: new Date() };
    if (patch.status !== undefined) data.status = patch.status;
    if (patch.provider !== undefined) data.provider = patch.provider;
    if (patch.attemptCount !== undefined) data.attemptCount = patch.attemptCount;
    if (patch.providerRequestId !== undefined) data.providerRequestId = patch.providerRequestId;
    if (Object.prototype.hasOwnProperty.call(patch, "result")) data.result = asNullableJson(patch.result);
    if (Object.prototype.hasOwnProperty.call(patch, "failureResponse")) data.failureResponse = asNullableJson(patch.failureResponse);
    if (patch.failureCode !== undefined) data.failureCode = patch.failureCode;
    if (patch.failureReason !== undefined) data.failureReason = patch.failureReason;
    if (patch.startedAt !== undefined) data.startedAt = new Date(patch.startedAt);
    if (patch.completedAt !== undefined) data.completedAt = new Date(patch.completedAt);

    const verification = await this.prisma.verification.update({ where: { id, ...(owner ? { application: { tenantId: owner.tenantId, clientId: owner.clientId } } : {}) }, data });
    return this.mapVerification(verification);
  }

  async updateApplicationStatus(applicationId: string, status: ApplicationStatus, owner?: ApplicationOwner): Promise<ApplicationRecord> {
    const application = await this.prisma.application.update({
      where: { id: applicationId, ...(owner ? { tenantId: owner.tenantId, clientId: owner.clientId } : {}) },
      data: { status, updatedAt: new Date() },
      include: { package: true, verificationCard: true, verifications: { select: { id: true }, orderBy: { createdAt: "asc" } } }
    });
    return this.mapApplication(application);
  }

  async recalculateApplicationStatus(applicationId: string, requestedOwner?: ApplicationOwner): Promise<ApplicationRecord> {
    const existing = await this.getApplication(applicationId, requestedOwner);
    if (!existing) throw new Error("Application not found");
    const owner = { tenantId: existing.tenantId, clientId: existing.clientId };
    return this.prisma.$transaction(async tx => {
      // Serialize recalculations for this case before reading its checkpoints.
      const { cardNumber: assignedCardNumber, workerPhone } = await tx.application.update({ where: { id: applicationId, ...owner }, data: { updatedAt: new Date() }, select: { cardNumber: true, workerPhone: true } });
      const checks = await tx.verification.findMany({ where: { applicationId, application: owner }, select: { status: true, type: true } });
      const status = applicationStatusForChecks(checks.map(check => check.status as VerificationStatus));
      await tx.application.update({ where: { id: applicationId, ...owner }, data: { status } });
      if (workerPhone) {
        // A worker's card is released once every chosen check has finished (none running or in
        // review), Aadhaar is verified and at least one check passed. It lists the checks that
        // passed. Adding checks later does not take it away; it shows as updating.
        if (workerCardReady(checks)) await tx.verificationCard.upsert({ where: { applicationId, ...owner }, update: {}, create: newCard(applicationId, owner, assignedCardNumber) });
      } else if (status === "VERIFIED") {
        const issuedAt = new Date();
        const expiresAt = new Date(issuedAt);
        expiresAt.setUTCFullYear(expiresAt.getUTCFullYear() + 1);
        await tx.verificationCard.upsert({ where: { applicationId, ...owner }, update: {}, create: {
          id: `card_${randomUUID()}`, applicationId, ...owner,
          cardNumber: assignedCardNumber ?? newCardNumber(issuedAt),
          publicId: randomUUID(), status: "ACTIVE", issuedAt, expiresAt,
        } });
      } else {
        await tx.verificationCard.updateMany({ where: { applicationId, ...owner, status: "ACTIVE" }, data: { status: "SUSPENDED" } });
      }
      const application = await tx.application.findFirstOrThrow({ where: { id: applicationId, ...owner }, include: { package: true, verificationCard: true, verifications: { select: { id: true }, orderBy: { createdAt: "asc" } } } });
      return this.mapApplication(application);
    });
  }

  async claimForProcessing(id: string, owner: ApplicationOwner, expectedAttempt: number): Promise<boolean> {
    const changed = await this.prisma.verification.updateMany({ where: { id, application: { tenantId: owner.tenantId, clientId: owner.clientId }, attemptCount: expectedAttempt, status: { in: ["QUEUED", "FAILED"] } }, data: { status: "PROCESSING", startedAt: new Date(), attemptCount: { increment: 1 } } });
    return changed.count === 1;
  }

  async hasDispatchedCall(id: string, owner: ApplicationOwner, afterAttempt = 0): Promise<boolean> {
    const calls = await this.prisma.providerCall.findMany({ where: { verificationId: id, tenantId: owner.tenantId, clientId: owner.clientId, state: { in: ["SUCCESS", "UNKNOWN", "STARTED"] } }, select: { operationKey: true } });
    // Operation keys carry the attempt (verification_<id>_attempt_<n>:...). Unparseable keys count as dispatched.
    return calls.some(({ operationKey }) => Number(/_attempt_(\d+):/.exec(operationKey)?.[1] ?? Infinity) > afterAttempt);
  }

  async findWorkerCase(owner: ApplicationOwner, workerPhone: string): Promise<ApplicationRecord | undefined> {
    const latest = await withTenantScope(this.prisma, owner).application.findFirst({
      where: { tenantId: owner.tenantId, clientId: owner.clientId, workerPhone },
      orderBy: { createdAt: "desc" },
      select: { id: true }
    });
    return latest ? this.getApplication(latest.id, owner) : undefined;
  }

  /** Opens a draft case. A concurrent open for the same worker returns the existing draft. */
  async createWorkerDraft(owner: ApplicationOwner, workerPhone: string, data: ApplicationSchema): Promise<ApplicationRecord> {
    try {
      const now = new Date();
      await this.prisma.application.create({ data: {
        id: `app_${randomUUID()}`, tenantId: owner.tenantId, clientId: owner.clientId, apiKeyId: owner.apiKeyId,
        status: "DRAFT", workerPhone, cardNumber: newCardNumber(now), data: asInputJson(data), createdAt: now, updatedAt: now
      } });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
    }
    const created = await this.findWorkerCase(owner, workerPhone);
    if (!created) throw new Error("Worker case was not created");
    return created;
  }

  /** Read-modify-write of case data, serialised per case. */
  async updateApplicationData(id: string, owner: ApplicationOwner, mutate: (data: ApplicationSchema) => ApplicationSchema, fields: { packageId?: string; status?: ApplicationStatus } = {}): Promise<ApplicationRecord> {
    await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ data: unknown }>>`SELECT "data" FROM "Application" WHERE "id" = ${id} AND "tenantId" = ${owner.tenantId} AND "clientId" = ${owner.clientId} FOR UPDATE`;
      if (!rows.length) throw new Error("Application not found");
      await tx.application.update({ where: { id, ...owner }, data: { data: asInputJson(mutate(rows[0].data as ApplicationSchema)), ...fields } });
    });
    const updated = await this.getApplication(id, owner);
    if (!updated) throw new Error("Application not found");
    return updated;
  }

  async getCardNumber(applicationId: string): Promise<string | undefined> {
    return (await this.prisma.application.findUnique({ where: { id: applicationId }, select: { cardNumber: true } }))?.cardNumber ?? undefined;
  }

  async addVerifications(applicationId: string, rows: Array<{ type: VerificationType; status: VerificationStatus }>): Promise<void> {
    if (!rows.length) return;
    const provider = process.env.VERIFICATION_PROVIDER || "surepass";
    const owner = await this.prisma.application.findUniqueOrThrow({ where: { id: applicationId }, select: { tenantId: true, clientId: true } });
    await this.prisma.verification.createMany({ data: rows.map((row) => ({
      id: `verification_${randomUUID()}`, applicationId, tenantId: owner.tenantId, clientId: owner.clientId, type: row.type, status: row.status, provider, attemptCount: 0
    })) });
  }

  async setResult(
    id: string,
    status: VerificationStatus,
    patch: Partial<VerificationRecord> = {},
    owner?: ApplicationOwner
  ): Promise<VerificationRecord> {
    return this.updateVerification(id, {
      status,
      completedAt: new Date().toISOString(),
      ...patch
    }, owner);
  }

  /** Packages on sale to everyone. A partner's custom bundle is never listed here. */
  async listActivePackages(): Promise<VerificationPackageRecord[]> {
    const packages = await this.prisma.verificationPackage.findMany({
      where: { isActive: true, tenantId: null },
      orderBy: [{ kind: "asc" }, { displayOrder: "asc" }, { version: "desc" }]
    });
    return packages.map((item) => this.mapPackage(item));
  }

  /** A package `tenantId` may use: on sale to everyone, or that partner's own custom bundle. */
  async getPackageByCode(code: string, version: number | undefined, tenantId: string): Promise<VerificationPackageRecord | undefined> {
    const normalizedCode = code.trim().toUpperCase();
    const item = version
      ? await this.prisma.verificationPackage.findUnique({
          where: { code_version: { code: normalizedCode, version } }
        })
      : await this.prisma.verificationPackage.findFirst({
          where: { code: normalizedCode, isActive: true },
          orderBy: { version: "desc" }
        });
    if (item?.tenantId && item.tenantId !== tenantId) return undefined;
    return item ? this.mapPackage(item) : undefined;
  }

  async getWorkerPortalOwner(): Promise<ApplicationOwner> {
    const client = await this.prisma.client.findFirst({
      where: { code: "WORKER_PORTAL", status: "ACTIVE", tenant: { status: "ACTIVE" } },
      select: { id: true, tenantId: true }
    });
    if (!client) throw new Error("Default worker portal client is not seeded");
    return { tenantId: client.tenantId, clientId: client.id };
  }

  private mapApplication(record: StoredApplication): ApplicationRecord {
    return {
      id: record.id,
      apiKeyId: record.apiKeyId ?? undefined,
      tenantId: record.tenantId,
      clientId: record.clientId,
      packageId: record.packageId || undefined,
      package: record.package ? {
        id: record.package.id,
        code: record.package.code,
        version: record.package.version,
        name: record.package.name,
        kind: record.package.kind as VerificationPackageKind,
        priceInr: record.package.priceInr || undefined,
        advertisedCheckCount: record.package.advertisedCheckCount || undefined
      } : undefined,
      status: record.status as ApplicationStatus,
      recommendation: this.recommendationFor(record.status as ApplicationStatus),
      card: record.verificationCard ? this.mapCard(record.verificationCard) : undefined,
      data: record.data as unknown as ApplicationSchema,
      workerCase: Boolean(record.workerPhone),
      verificationIds: record.verifications?.map((verification) => verification.id) || [],
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString()
    };
  }

  private recommendationFor(status: ApplicationStatus): FinalRecommendation {
    if (status === "VERIFIED") return "PASS";
    if (status === "VERIFICATION_FAILED") return "FAIL";
    if (status === "MANUAL_REVIEW") return "MANUAL_REVIEW";
    return "PENDING";
  }

  private mapCard(record: StoredVerificationCard): VerificationCardRecord {
    return {
      id: record.id,
      applicationId: record.applicationId,
      cardNumber: record.cardNumber,
      publicId: record.publicId,
      status: record.status as VerificationCardRecord["status"],
      issuedAt: record.issuedAt.toISOString(),
      expiresAt: record.expiresAt.toISOString()
    };
  }

  private mapPackage(record: StoredPackage): VerificationPackageRecord {
    return {
      id: record.id,
      code: record.code,
      version: record.version,
      name: record.name,
      description: record.description || undefined,
      kind: record.kind as VerificationPackageKind,
      priceInr: record.priceInr || undefined,
      advertisedCheckCount: record.advertisedCheckCount || undefined,
      targetWorkforce: record.targetWorkforce || undefined,
      displayOrder: record.displayOrder,
      isActive: record.isActive,
      checks: record.checks as PackageCheckRule[],
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString()
    };
  }

  private mapVerification(record: StoredVerification): VerificationRecord {
    return {
      id: record.id,
      applicationId: record.applicationId,
      type: record.type as VerificationType,
      status: record.status as VerificationStatus,
      provider: record.provider,
      attemptCount: record.attemptCount,
      providerRequestId: record.providerRequestId || undefined,
      result: record.result ? record.result as Record<string, unknown> : undefined,
      failureResponse: record.failureResponse ? record.failureResponse as Record<string, unknown> : undefined,
      failureCode: record.failureCode || undefined,
      failureReason: record.failureReason || undefined,
      createdAt: record.createdAt.toISOString(),
      startedAt: record.startedAt?.toISOString(),
      completedAt: record.completedAt?.toISOString(),
      updatedAt: record.updatedAt.toISOString()
    };
  }
}

