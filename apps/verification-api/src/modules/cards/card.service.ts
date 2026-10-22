import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { ClientContext } from "../../common/auth/client-context";
import type { WorkerIdentity } from "../../common/auth/worker-token";
import { PrismaService } from "../../common/database/prisma.service";
import type { ApplicationSchema } from "../../domain/verification.types";
import { issueLiveToken } from "./card-token";
import { cardStatus } from "./card-views";

export type { CardStatus } from "./card-views";

/** The worker's own Liwip BGV Card: the card so far, or the issued card with its live QR. */
@Injectable()
export class CardService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  private async workerCase(worker: WorkerIdentity) {
    const application = await this.prisma.application.findFirst({
      where: { tenantId: worker.tenantId, clientId: worker.clientId, workerPhone: worker.phone },
      orderBy: { createdAt: "desc" },
      include: { verificationCard: true, verifications: { orderBy: { createdAt: "asc" } } }
    });
    if (!application) throw new NotFoundException("Open your case first");
    return application;
  }

  async forWorker(worker: WorkerIdentity, _client: ClientContext) {
    const application = await this.workerCase(worker);
    const data = application.data as unknown as ApplicationSchema;
    // Latest row per check type, in the order the worker chose them.
    const latest = new Map<string, (typeof application.verifications)[number]>();
    for (const row of application.verifications) latest.set(row.type, row);
    const checks = [...latest.values()].map((row) => ({
      type: row.type,
      status: row.status,
      completedAt: row.status === "VERIFIED" ? row.completedAt?.toISOString() ?? row.updatedAt.toISOString() : null,
      source: row.type === "AADHAAR" ? data.identity?.source ?? null : data.documentSources?.[row.type]?.source ?? null,
      signedBy: data.documentSources?.[row.type]?.signedBy ?? null
    }));
    const hasPhoto = Boolean(await this.prisma.workerPhoto.count({ where: { applicationId: application.id } }) || await this.prisma.aadhaarPhoto.count({ where: { applicationId: application.id } }));
    const name = data.personal?.declaredName || data.personal?.nameAsAadhaar || null;
    const card = application.verificationCard;
    const base = {
      name,
      hasPhoto,
      checks,
      verifiedCount: checks.filter((check) => check.status === "VERIFIED").length,
      totalCount: checks.length
    };
    if (!card) return { issued: false as const, ...base };

    const now = Date.now();
    const status = cardStatus(card, checks, now);
    const qrOn = status !== "expired" && status !== "suspended";
    const scansLastWeek = await this.prisma.cardScan.count({ where: { cardId: card.id, scannedAt: { gte: new Date(now - 7 * 86_400_000) } } });
    return {
      issued: true as const,
      ...base,
      cardNumber: card.cardNumber,
      issuedAt: card.issuedAt.toISOString(),
      expiresAt: card.expiresAt.toISOString(),
      status,
      // The fixed link printed on the card; the live code changes every two minutes.
      fixedToken: qrOn ? card.publicId : null,
      live: qrOn ? issueLiveToken(card.publicId) : null,
      scansLastWeek
    };
  }

  /** A fresh live QR code, without reloading the whole card. */
  async liveCode(worker: WorkerIdentity) {
    const application = await this.workerCase(worker);
    const card = application.verificationCard;
    if (!card || card.status !== "ACTIVE" || card.expiresAt.getTime() <= Date.now()) throw new NotFoundException("No active card");
    return issueLiveToken(card.publicId);
  }

  /** The face-matched selfie, or the Aadhaar photo when there is no selfie. */
  async photo(worker: WorkerIdentity) {
    const application = await this.workerCase(worker);
    const photo = await this.prisma.workerPhoto.findUnique({ where: { applicationId: application.id } })
      ?? await this.prisma.aadhaarPhoto.findUnique({ where: { applicationId: application.id } });
    if (!photo) throw new NotFoundException("No photo");
    return { bytes: Buffer.from(photo.bytes), contentType: photo.contentType };
  }

  /** New card link; the old QR and shared link stop working at once. */
  async reissue(worker: WorkerIdentity) {
    const application = await this.workerCase(worker);
    const card = application.verificationCard;
    if (!card) throw new ConflictException("Your card has not been issued yet");
    await this.prisma.verificationCard.update({ where: { id: card.id }, data: { publicId: randomUUID() } });
    return { reissued: true };
  }
}
