import { Controller, Get, Inject, NotFoundException, Param, Req } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { Request } from "express";
import { randomUUID } from "node:crypto";
import { AuditService } from "../../common/audit/audit.service";
import { PrismaService } from "../../common/database/prisma.service";
import { RateLimitService } from "../../common/security/rate-limit.service";
import { hashIp } from "../admin-access/admin-config";
import { resolveCardToken } from "./card-token";
import { photoDataUrl, publicCardView } from "./card-views";

/**
 * Anyone holding a worker's card (printed QR, shared link or the live QR in the app) can
 * check it here. Rate limited per IP; minimal data only (photo, name, card status,
 * valid-until, check categories passed). Every scan is logged.
 */
@Controller("v1/public/cards")
export class PublicCardController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RateLimitService) private readonly limits: RateLimitService,
    @Inject(AuditService) private readonly audit: AuditService
  ) {}

  @Get("verify/:token")
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async verify(@Param("token") token: string, @Req() request: Request) {
    await this.limits.consume("cardVerifyPerIp", request.ip || "unknown");
    const resolved = resolveCardToken(String(token || "").slice(0, 200));
    const card = resolved && await this.prisma.verificationCard.findUnique({
      where: { publicId: resolved.publicId },
      include: { application: { select: { id: true, data: true, verifications: { select: { type: true, status: true, createdAt: true, completedAt: true, updatedAt: true } } } } }
    });
    if (!resolved || !card) {
      this.audit.record({ actorType: "PUBLIC", action: "cards.verify.public", outcome: "CLIENT_ERROR", statusCode: 404, method: "GET", path: request.route?.path ?? null, ip: request.ip ?? null, message: resolved ? "Card not found" : "Invalid or expired code" });
      throw new NotFoundException("This code is not valid or has expired");
    }
    const photo = photoDataUrl(await this.prisma.workerPhoto.findFirst({ where: { applicationId: card.applicationId } }) ?? await this.prisma.aadhaarPhoto.findFirst({ where: { applicationId: card.applicationId } }));
    const view = publicCardView({ card, checks: card.application.verifications, data: card.application.data, photo });
    await this.prisma.cardScan.create({
      data: { id: `card_scan_${randomUUID()}`, cardId: card.id, tenantId: card.tenantId, clientId: card.clientId, via: resolved.via, result: view.status.toUpperCase(), ipHash: hashIp(request.ip) ?? "unknown", viewerType: "PUBLIC", view: "PUBLIC" }
    });
    this.audit.record({ actorType: "PUBLIC", action: "cards.verify.public", outcome: "SUCCESS", statusCode: 200, method: "GET", path: request.route?.path ?? null, tenantId: card.tenantId, clientId: card.clientId, resourceType: "VerificationCard", resourceId: card.id, ip: request.ip ?? null, metadata: { via: resolved.via, status: view.status } });
    return view;
  }
}
