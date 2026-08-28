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
  id: string;
  tenantId: string;
  clientId: string;
  packageId: string | null;
  status: string;
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
    const provider = "surepass";

    await this.prisma.$transaction(async (transaction) => {
      await transaction.application.create({
        data: {
          id: applicationId,
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
    const application = await this.prisma.application.findFirst({
      where: { id, ...(owner ? { tenantId: owner.tenantId, clientId: owner.clientId } : {}) },
      include: { package: true, verificationCard: true, verifications: { select: { id: true }, orderBy: { createdAt: "asc" } } }
    });
    return application ? this.mapApplication(application) : undefined;
  }

  async getVerification(id: string, owner?: ApplicationOwner): Promise<VerificationRecord | undefined> {
    const verification = await this.prisma.verification.findFirst({
      where: { id, ...(owner ? { application: { tenantId: owner.tenantId, clientId: owner.clientId } } : {}) }
    });
    return verification ? this.mapVerification(verification) : undefined;
  }

  async getVerificationsForApplication(applicationId: string, owner?: ApplicationOwner): Promise<VerificationRecord[]> {
    const verifications = await this.prisma.verification.findMany({
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

  async updateVerification(id: string, patch: Partial<VerificationRecord>): Promise<VerificationRecord> {
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

    const verification = await this.prisma.verification.update({ where: { id }, data });
    return this.mapVerification(verification);
  }

  async updateApplicationStatus(applicationId: string, status: ApplicationStatus): Promise<ApplicationRecord> {
    const application = await this.prisma.application.update({
      where: { id: applicationId },
      data: { status, updatedAt: new Date() },
      include: { package: true, verificationCard: true, verifications: { select: { id: true }, orderBy: { createdAt: "asc" } } }
    });
    return this.mapApplication(application);
  }

  async recalculateApplicationStatus(applicationId: string): Promise<ApplicationRecord> {
    const application = await this.getApplication(applicationId);
    if (!application) throw new Error(`Application ${applicationId} not found`);
    const checks = await this.getVerificationsForApplication(applicationId);
    const statuses = checks.map((check) => check.status);
    let status: ApplicationStatus = "VERIFICATION_IN_PROGRESS";

    if (statuses.some((value) => value === "MANUAL_REVIEW")) status = "MANUAL_REVIEW";
    else if (statuses.some((value) => value === "FAILED")) status = "VERIFICATION_FAILED";
    else if (checks.length > 0 && statuses.every((value) => value === "VERIFIED")) status = "VERIFIED";
    else if (statuses.every((value) => value === "QUEUED" || value === "PENDING")) status = "PENDING_VERIFICATION";

    await this.updateApplicationStatus(applicationId, status);
    if (status === "VERIFIED") await this.issueVerificationCard(applicationId, application.tenantId, application.clientId);
    const updated = await this.getApplication(applicationId);
    if (!updated) throw new Error(`Application ${applicationId} not found after status update`);
    return updated;
  }

  private async issueVerificationCard(applicationId: string, tenantId: string, clientId: string): Promise<void> {
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt);
    expiresAt.setUTCFullYear(expiresAt.getUTCFullYear() + 1);
    const cardNumber = `LIWIP-${issuedAt.getUTCFullYear()}-${randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`;
    await this.prisma.verificationCard.upsert({
      where: { applicationId },
      update: {},
      create: {
        id: `card_${randomUUID()}`,
        applicationId,
        tenantId,
        clientId,
        cardNumber,
        publicId: randomUUID(),
        status: "ACTIVE",
        issuedAt,
        expiresAt
      }
    });
  }

  async setProcessing(id: string): Promise<VerificationRecord> {
    return this.updateVerification(id, { status: "PROCESSING", startedAt: new Date().toISOString() });
  }

  async setResult(
    id: string,
    status: VerificationStatus,
    patch: Partial<VerificationRecord> = {}
  ): Promise<VerificationRecord> {
    return this.updateVerification(id, {
      status,
      completedAt: new Date().toISOString(),
      ...patch
    });
  }

  async listActivePackages(): Promise<VerificationPackageRecord[]> {
    const packages = await this.prisma.verificationPackage.findMany({
      where: { isActive: true },
      orderBy: [{ kind: "asc" }, { displayOrder: "asc" }, { version: "desc" }]
    });
    return packages.map((item) => this.mapPackage(item));
  }

  async getPackageByCode(code: string, version?: number): Promise<VerificationPackageRecord | undefined> {
    const normalizedCode = code.trim().toUpperCase();
    const item = version
      ? await this.prisma.verificationPackage.findUnique({
          where: { code_version: { code: normalizedCode, version } }
        })
      : await this.prisma.verificationPackage.findFirst({
          where: { code: normalizedCode, isActive: true },
          orderBy: { version: "desc" }
        });
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
