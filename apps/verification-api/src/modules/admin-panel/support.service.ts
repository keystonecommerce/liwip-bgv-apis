import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import IORedis from "ioredis";
import { PrismaService } from "../../common/database/prisma.service";
import { RateLimitService } from "../../common/security/rate-limit.service";
import { redisConnectionOptions } from "../../config/redis";

/**
 * Keystone support tools (support.manage), from the admin apps. They replace the old
 * X-Admin-Key routes. Each one is a powerful action, so the routes need a recent sign-in.
 */
@Injectable()
export class SupportService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService, @Inject(RateLimitService) private readonly limits: RateLimitService) {}

  /**
   * Fresh start for one worker (testing and support). Their cases are archived,
   * not deleted, so provider-call and billing records stay intact; their passkeys
   * are removed. The next sign-in opens a new draft case.
   */
  async resetPerson(input: { phone?: string; clientId?: string }) {
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

  /** Puts checks back to waiting for the worker, so they can submit again. Progress elsewhere is kept. */
  async reopenChecks(caseId: string, input: { types?: unknown }) {
    const types = (Array.isArray(input?.types) ? input.types : []).map((type) => String(type).toUpperCase());
    if (!types.length || types.some((type) => type === "AADHAAR")) throw new BadRequestException("types must list checks to reopen (not AADHAAR)");
    const application = await this.prisma.application.findUnique({ where: { id: caseId }, select: { id: true } });
    if (!application) throw new NotFoundException("Case not found");
    const reopened = await this.prisma.verification.updateMany({
      where: { applicationId: application.id, type: { in: types }, status: { in: ["VERIFIED", "FAILED", "MANUAL_REVIEW"] } },
      data: { status: "PENDING", result: Prisma.DbNull, failureCode: null, failureReason: null, failureResponse: Prisma.DbNull, completedAt: null }
    });
    // A released card stays; it shows as updating until the reopened checks finish.
    await this.prisma.application.update({ where: { id: application.id }, data: { status: "PENDING_VERIFICATION" } });
    return { applicationId: application.id, reopened: reopened.count };
  }

}
