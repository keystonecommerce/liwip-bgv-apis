import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import IORedis from "ioredis";
import { redisConnectionOptions } from "../../config/redis";
import { PrismaService } from "../../common/database/prisma.service";
import { RateLimitService } from "../../common/security/rate-limit.service";
import { PartnerProvisioning, CreatePartnerInput, IssueKeyInput } from "../../common/security/partner-provisioning";
export type { CreatePartnerInput, IssueKeyInput } from "../../common/security/partner-provisioning";
@Injectable()
export class AdminService {
  private readonly provisioning: PartnerProvisioning;
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService, @Inject(RateLimitService) private readonly limits: RateLimitService) { this.provisioning = new PartnerProvisioning(prisma); }
  createPartner(input: CreatePartnerInput) { return this.provisioning.createPartner(input); }
  issueKey(clientId: string, input: IssueKeyInput) { return this.provisioning.issueKey(clientId, input); }
  rotateKey(id: string) { return this.provisioning.rotateKey(id); }
  revokeKey(id: string) { return this.provisioning.revokeKey(id); }
  async listPartners(limit = 50) {
    const tenants = await this.prisma.tenant.findMany({
      orderBy: { createdAt: "desc" },
      take: limit,
      include: {
        clients: {
          include: {
            apiKeys: {
              orderBy: { createdAt: "desc" },
              select: { id: true, name: true, keyPrefix: true, scopes: true, isActive: true, expiresAt: true, lastUsedAt: true, revokedAt: true, createdAt: true },
            },
          },
        },
      },
    });
    return { tenants };
  }

  /**
   * Fresh start for one worker (testing and support). Their cases are archived,
   * not deleted, so provider-call and billing records stay intact; their passkeys
   * are removed. The next sign-in opens a new draft case.
   */
  async resetWorker(input: { phone?: string; clientId?: string }) {
    const national = String(input?.phone || "").replace(/\D/g, "").replace(/^91(?=\d{10}$)/, "");
    if (!/^[6-9]\d{9}$/.test(national)) throw new BadRequestException("phone must be a 10-digit Indian mobile number");
    const phone = `91${national}`;
    const scope = input?.clientId ? { clientId: String(input.clientId) } : {};
    const archivedAs = `archived:${Date.now()}:${phone}`;
    // The worker's own limits (keyed by tenant, client and phone) start fresh too.
    const owners = await this.prisma.application.findMany({ where: { workerPhone: phone, ...scope }, select: { tenantId: true, clientId: true }, distinct: ["tenantId", "clientId"] });
    for (const owner of owners) {
      await this.limits.clear(["aadhaarPerWorker", "checkPerWorkerHour", "checkPerWorkerDay", "passkeySetupPerWorker", "caseEditsPerWorker"], `${owner.tenantId}:${owner.clientId}:${phone}`);
    }
    return this.prisma.$transaction(async (tx) => {
      const cases = await tx.application.updateMany({ where: { workerPhone: phone, ...scope }, data: { workerPhone: archivedAs, status: "ARCHIVED" } });
      const passkeys = await tx.workerPasskey.deleteMany({ where: { workerPhone: phone, ...scope } });
      return { phone: `******${national.slice(-4)}`, casesArchived: cases.count, passkeysRemoved: passkeys.count };
    });
  }

  /**
   * Hard delete of ALL worker data, for resetting a test environment. Off unless
   * ADMIN_PURGE_ENABLED=true and the exact confirmation phrase is sent. Keeps
   * tenants, clients, API keys, packages and portal users.
   */
  async purgeWorkerData(input: { confirm?: string }) {
    if (process.env.ADMIN_PURGE_ENABLED !== "true") throw new ForbiddenException("Purge is disabled");
    if (input?.confirm !== "DELETE ALL WORKER DATA") throw new BadRequestException('Send {"confirm":"DELETE ALL WORKER DATA"}');
    const tables = ["ProviderCall", "UsageEvent", "FieldEvidence", "FieldTask", "VerificationCard", "ApplicationDocument", "Verification", "Application", "AadhaarOvseSession", "WorkerPasskey", "AuditLog"];
    const deleted = await this.prisma.$transaction(async (tx) => {
      // The ledger refuses deletes by design; lift that only inside this transaction.
      await tx.$executeRawUnsafe('ALTER TABLE "ProviderCall" DISABLE TRIGGER "ProviderCall_immutable"');
      const counts: Record<string, number> = {};
      for (const table of tables) counts[table] = await tx.$executeRawUnsafe(`DELETE FROM "${table}"`);
      await tx.$executeRawUnsafe('ALTER TABLE "ProviderCall" ENABLE TRIGGER "ProviderCall_immutable"');
      return counts;
    }, { timeout: 60_000 });

    // OTP challenges, passkey challenges, rate-limit counters and queued jobs.
    const redis = new IORedis({ ...redisConnectionOptions(), maxRetriesPerRequest: 1 });
    let redisKeys = 0;
    try {
      for (const pattern of ["liwip:*", "gig-verification-v1:*"]) {
        let cursor = "0";
        do {
          const [next, keys] = await redis.scan(cursor, "MATCH", pattern, "COUNT", 500);
          cursor = next;
          if (keys.length) redisKeys += await redis.del(...keys);
        } while (cursor !== "0");
      }
    } finally {
      redis.disconnect();
    }
    return { deleted, redisKeys };
  }

  /** Support view of one worker's current case: each check's state and the name the provider returned. */
  async inspectWorker(phoneInput: string) {
    const phone = this.workerPhone(phoneInput);
    const application = await this.prisma.application.findFirst({
      where: { workerPhone: phone }, orderBy: { createdAt: "desc" },
      include: { verifications: { orderBy: { createdAt: "asc" } } }
    });
    if (!application) throw new NotFoundException("No case for this number");
    const data = application.data as { personal?: Record<string, unknown>; identity?: Record<string, unknown> };
    const NAME_FIELDS = ["full_name", "name", "owner_name", "name_on_card", "father_name", "rc_status", "status", "doe", "fit_up_to", "insurance_upto"];
    return {
      applicationId: application.id,
      status: application.status,
      names: { aadhaar: data.identity?.fullName ?? null, declared: data.personal?.declaredName ?? null, matchedAgainst: data.personal?.nameAsAadhaar ?? null },
      checks: application.verifications.map((row) => ({
        id: row.id, type: row.type, status: row.status, failureCode: row.failureCode, failureReason: row.failureReason,
        // Only the fields that explain a decision, never document numbers.
        provider: Object.fromEntries(Object.entries((row.result ?? {}) as Record<string, unknown>).filter(([key]) => NAME_FIELDS.includes(key))),
        providerError: row.failureResponse ?? null,
        updatedAt: row.updatedAt
      }))
    };
  }

  /** Puts checks back to waiting for the worker, so they can submit again. Progress elsewhere is kept. */
  async reopenChecks(input: { phone?: string; types?: string[] }) {
    const phone = this.workerPhone(String(input?.phone || ""));
    const types = (Array.isArray(input?.types) ? input.types : []).map((type) => String(type).toUpperCase());
    if (!types.length || types.some((type) => type === "AADHAAR")) throw new BadRequestException("types must list checks to reopen (not AADHAAR)");
    const application = await this.prisma.application.findFirst({ where: { workerPhone: phone }, orderBy: { createdAt: "desc" }, select: { id: true } });
    if (!application) throw new NotFoundException("No case for this number");
    const reopened = await this.prisma.verification.updateMany({
      where: { applicationId: application.id, type: { in: types }, status: { in: ["VERIFIED", "FAILED", "MANUAL_REVIEW"] } },
      data: { status: "PENDING", result: Prisma.DbNull, failureCode: null, failureReason: null, failureResponse: Prisma.DbNull, completedAt: null }
    });
    await this.prisma.verificationCard.updateMany({ where: { applicationId: application.id, status: "ACTIVE" }, data: { status: "SUSPENDED" } });
    await this.prisma.application.update({ where: { id: application.id }, data: { status: "PENDING_VERIFICATION" } });
    return { applicationId: application.id, reopened: reopened.count };
  }

  private workerPhone(input: string): string {
    const national = String(input || "").replace(/\D/g, "").replace(/^91(?=\d{10}$)/, "");
    if (!/^[6-9]\d{9}$/.test(national)) throw new BadRequestException("phone must be a 10-digit Indian mobile number");
    return `91${national}`;
  }
}
