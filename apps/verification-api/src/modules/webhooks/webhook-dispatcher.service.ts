import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { PrismaService } from "../../common/database/prisma.service";
import { decryptSecret, signatureHeader } from "./webhook-secrets";
import { assertDeliverable } from "./webhook-url";

/** Waits before each retry, by attempts made so far: 1 min, 5 min, 15 min, 1 h, 3 h, 6 h, 12 h. */
export const RETRY_DELAYS_MS = [60_000, 300_000, 900_000, 3_600_000, 10_800_000, 21_600_000, 43_200_000];
export const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;
const BATCH = 20;
const TIMEOUT_MS = 10_000;
// A delivery claimed by a process that died is picked up again after this long.
const STALE_MS = 120_000;

/**
 * Sends webhook deliveries from the outbox: signed, one POST each, 2xx means delivered. Failures
 * retry with backoff and stop after MAX_ATTEMPTS (Keystone or the partner can retry by hand).
 * Polls every WEBHOOK_POLL_MS (default 5 s); WEBHOOK_JOBS=off stops polling (tests call runOnce).
 */
@Injectable()
export class WebhookDispatcher implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WebhookDispatcher.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  onModuleInit() {
    if (process.env.WEBHOOK_JOBS === "off") return;
    const every = Math.max(1000, Number(process.env.WEBHOOK_POLL_MS) || 5000);
    this.timer = setInterval(() => void this.runOnce().catch((error) => this.logger.warn(`Webhook run failed: ${error instanceof Error ? error.message : "unknown"}`)), every);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Sends what is due now. Returns how many deliveries were attempted. */
  async runOnce(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const now = new Date();
      const due = await this.prisma.webhookDelivery.findMany({
        where: { OR: [{ status: "PENDING", nextAttemptAt: { lte: now } }, { status: "DELIVERING", updatedAt: { lt: new Date(now.getTime() - STALE_MS) } }] },
        orderBy: { nextAttemptAt: "asc" },
        take: BATCH,
        select: { id: true, status: true, updatedAt: true }
      });
      let attempted = 0;
      for (const row of due) {
        // Claim it, so two processes never send the same delivery at once.
        const claimed = await this.prisma.webhookDelivery.updateMany({ where: { id: row.id, status: row.status, updatedAt: row.updatedAt }, data: { status: "DELIVERING" } });
        if (!claimed.count) continue;
        attempted++;
        await this.send(row.id);
      }
      return attempted;
    } finally {
      this.running = false;
    }
  }

  private async send(deliveryId: string) {
    const delivery = await this.prisma.webhookDelivery.findUniqueOrThrow({ where: { id: deliveryId }, include: { endpoint: true } });
    const attempts = delivery.attempts + 1;
    let statusCode: number | null = null;
    let error: string | null = null;
    if (delivery.endpoint.status !== "ACTIVE") {
      error = "endpoint disabled";
    } else {
      try {
        await assertDeliverable(delivery.endpoint.url);
        const body = JSON.stringify(delivery.payload);
        const response = await fetch(delivery.endpoint.url, {
          method: "POST",
          redirect: "manual",
          signal: AbortSignal.timeout(TIMEOUT_MS),
          headers: {
            "content-type": "application/json",
            "user-agent": "Liwip-Webhooks/1",
            "liwip-event": delivery.event,
            "liwip-delivery": delivery.id,
            "liwip-signature": signatureHeader(decryptSecret(delivery.endpoint.secretCiphertext), body)
          },
          body
        });
        statusCode = response.status;
        await response.body?.cancel().catch(() => undefined);
        if (statusCode < 200 || statusCode >= 300) error = `HTTP ${statusCode}`;
      } catch (failure) {
        error = (failure instanceof Error ? failure.message : "request failed").slice(0, 200);
      }
    }
    if (!error) {
      await this.prisma.webhookDelivery.update({ where: { id: delivery.id }, data: { status: "DELIVERED", attempts, lastStatusCode: statusCode, lastError: null, deliveredAt: new Date() } });
      return;
    }
    const done = attempts >= MAX_ATTEMPTS || delivery.endpoint.status !== "ACTIVE";
    await this.prisma.webhookDelivery.update({
      where: { id: delivery.id },
      data: { status: done ? "FAILED" : "PENDING", attempts, lastStatusCode: statusCode, lastError: error, nextAttemptAt: new Date(Date.now() + (RETRY_DELAYS_MS[attempts - 1] ?? 0)) }
    });
  }
}
