import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Queue, Worker } from "bullmq";
import IORedis from "ioredis";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../../common/database/prisma.service";

const connectionOptions = {
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: Number(process.env.REDIS_PORT || 6380),
  maxRetriesPerRequest: null as null,
};

const queueName = "usage-metering";
const queuePrefix = "gig-verification-v1";

export type UsageResult = "VERIFIED" | "NEGATIVE" | "MANUAL_REVIEW" | "ERROR";

export interface UsageJob {
  tenantId: string;
  clientId: string;
  applicationId: string;
  verificationId: string;
  checkType: string;
  result: UsageResult;
  billable: boolean;
  provider?: string | null;
}

/**
 * Records one billing/metering event per verification, off the request path via
 * BullMQ. The write is idempotent (unique verificationId), so retries and
 * re-processed jobs never double-count a partner's usage.
 */
@Injectable()
export class UsageQueue implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(UsageQueue.name);
  private readonly connection = new IORedis(connectionOptions);
  private readonly queue = new Queue<UsageJob>(queueName, { connection: this.connection, prefix: queuePrefix });
  private worker?: Worker<UsageJob>;

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    this.worker = new Worker<UsageJob>(queueName, async (job) => this.persist(job.data), {
      connection: this.connection,
      prefix: queuePrefix,
      concurrency: 5,
    });
    this.worker.on("failed", (job, error) => {
      this.logger.warn(`Usage event failed for ${job?.data?.verificationId}: ${error?.message ?? error}`);
    });
  }

  /** Enqueue a metering event. Safe to call from the verification worker. */
  async record(job: UsageJob): Promise<void> {
    try {
      // No static jobId: a verification can reach a second terminal state (e.g.
      // provider MANUAL_REVIEW then a human VERIFIED/FAILED), and we want that
      // second event to update the ledger row. Idempotency/no double-count is
      // guaranteed by the DB unique `verificationId` + upsert in persist().
      await this.queue.add("usage.record", job, {
        attempts: 5,
        backoff: { type: "exponential", delay: 3000 },
        removeOnComplete: 500,
        removeOnFail: 200,
      });
    } catch (error) {
      // Metering must never break verification processing.
      this.logger.warn(`Could not enqueue usage event for ${job.verificationId}: ${(error as Error)?.message ?? error}`);
    }
  }

  private async persist(data: UsageJob): Promise<void> {
    await this.prisma.usageEvent.upsert({
      where: { verificationId: data.verificationId },
      update: { result: data.result, billable: data.billable, provider: data.provider ?? null },
      create: {
        id: `usage_${randomUUID()}`,
        tenantId: data.tenantId,
        clientId: data.clientId,
        applicationId: data.applicationId,
        verificationId: data.verificationId,
        checkType: data.checkType,
        result: data.result,
        billable: data.billable,
        provider: data.provider ?? null,
      },
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue.close();
    await this.connection.quit();
  }
}
