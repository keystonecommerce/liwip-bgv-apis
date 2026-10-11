import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Queue, Worker } from "bullmq";
import IORedis from "ioredis";
import { redisConnectionOptions } from "../../../config/redis";
import type { ApplicationOwner } from "../../../domain/verification.types";
import { DigiLockerCompletion } from "./completion.service";

const QUEUE = "digilocker-completion";
// Same prefix as the verification queue, so test resets clear both.
const PREFIX = "gig-verification-v1";
const EVERY_MS = 10_000;
/** DigiLocker links last 10 minutes; keep watching a little longer, then stop. */
const WATCH_FOR_MS = 15 * 60_000;

interface CompletionJob {
  applicationId: string;
  tenantId: string;
  clientId: string;
  startedAt: number;
}

/**
 * Watches a DigiLocker session from the server: every 10 seconds, until the worker has tapped
 * Allow and everything shared is processed, or 15 minutes pass. The worker does not need to
 * come back to our app for their checks to be done.
 */
@Injectable()
export class DigiLockerCompletionQueue implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DigiLockerCompletionQueue.name);
  private readonly connection = new IORedis(redisConnectionOptions());
  private readonly queue = new Queue<CompletionJob>(QUEUE, { connection: this.connection, prefix: PREFIX });
  private worker?: Worker<CompletionJob>;

  constructor(@Inject(DigiLockerCompletion) private readonly completion: DigiLockerCompletion) {}

  /** Starts watching a session that was just opened. */
  async watch(applicationId: string, owner: ApplicationOwner) {
    await this.add({ applicationId, ...owner, startedAt: Date.now() });
  }

  async onModuleInit() {
    this.worker = new Worker<CompletionJob>(QUEUE, async (job) => {
      const { applicationId, tenantId, clientId, startedAt } = job.data;
      let outcome: "done" | "waiting";
      try {
        outcome = await this.completion.run(applicationId, { tenantId, clientId });
      } catch (error) {
        // A provider hiccup: try again on the next tick, within the watch window.
        this.logger.warn(`DigiLocker completion attempt failed: ${error instanceof Error ? error.name : "unknown error"}`);
        outcome = "waiting";
      }
      if (outcome === "waiting" && Date.now() - startedAt < WATCH_FOR_MS) await this.add(job.data);
    }, { connection: this.connection, prefix: PREFIX, concurrency: 5 });
  }

  async onModuleDestroy() {
    await this.worker?.close();
    await this.queue.close();
    await this.connection.quit().catch(() => undefined);
  }

  private async add(job: CompletionJob) {
    await this.queue.add("complete", job, { delay: EVERY_MS, removeOnComplete: true, removeOnFail: 50 });
  }
}
