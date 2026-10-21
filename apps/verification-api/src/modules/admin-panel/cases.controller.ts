import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { RateLimitService } from "../../common/security/rate-limit.service";
import { AdminAccessGuard } from "../admin-access/admin-access.guard";
import { AdminContext, AuditAction, CurrentAdmin, RequirePermission, SignedIn, RecentSignIn } from "../admin-access/admin-context";
import { CardLookupService } from "./card-lookup.service";
import { CaseListQuery, CasesService } from "./cases.service";
import { id, pageOf } from "./input";

/**
 * Cases for the admin panel. Partner staff see their partner's cases (scoped client);
 * Keystone staff see one partner with x-partner-id or every partner without it.
 */
@Controller("v1/admin/cases")
@UseGuards(AdminAccessGuard)
export class CasesController {
  constructor(@Inject(CasesService) private readonly cases: CasesService) {}

  @Get()
  @RequirePermission("cases.read", { allPartners: true })
  @AuditAction("cases.list")
  list(@CurrentAdmin() admin: AdminContext, @Query() query: CaseListQuery & { page?: string; limit?: string }) {
    return this.cases.list(admin, query, pageOf(query));
  }

  @Get(":caseId")
  @RequirePermission("cases.read", { allPartners: true })
  @AuditAction("cases.read", { resourceType: "Application", resourceParam: "caseId" })
  detail(@CurrentAdmin() admin: AdminContext, @Param("caseId") caseId: string) {
    return this.cases.detail(admin, id(caseId, "caseId"));
  }

  /** A signed S3 URL valid for a few minutes (S3_PRESIGNED_URL_EXPIRY_SECONDS). */
  @Get(":caseId/documents/:documentId/url")
  @RequirePermission("cases.documents.read", { allPartners: true })
  @AuditAction("cases.documents.url", { resourceType: "ApplicationDocument", resourceParam: "documentId" })
  documentUrl(@CurrentAdmin() admin: AdminContext, @Param("caseId") caseId: string, @Param("documentId") documentId: string) {
    return this.cases.documentUrl(admin, id(caseId, "caseId"), id(documentId, "documentId"));
  }

  /** The worker left the partner. The partner keeps the case as of now; the worker keeps their card. */
  @Post(":caseId/relationship/end")
  @HttpCode(200)
  @RequirePermission("workers.offboard", { allPartners: true })
  @AuditAction("cases.relationship.end", { resourceType: "Application", resourceParam: "caseId" })
  endRelationship(@CurrentAdmin() admin: AdminContext, @Param("caseId") caseId: string, @Body() body: { reason?: string }) {
    return this.cases.endRelationship(admin, id(caseId, "caseId"), body ?? {});
  }

  @Post(":caseId/checks/:checkId/decision")
  @HttpCode(200)
  @RequirePermission("cases.decide", { allPartners: true })
  @RecentSignIn()
  @AuditAction("cases.checks.decide", { resourceType: "Application", resourceParam: "caseId" })
  decide(@CurrentAdmin() admin: AdminContext, @Param("caseId") caseId: string, @Param("checkId") checkId: string, @Body() body: { decision?: string; note?: string }) {
    return this.cases.decide(admin, id(caseId, "caseId"), id(checkId, "checkId"), body ?? {});
  }
}

/** Card lookups by QR token or card number, for any signed-in staff account. */
@Controller("v1/admin/cards")
@UseGuards(AdminAccessGuard)
export class CardLookupController {
  constructor(@Inject(CardLookupService) private readonly cards: CardLookupService, @Inject(RateLimitService) private readonly limits: RateLimitService) {}

  @Post("lookup")
  @HttpCode(200)
  @SignedIn()
  @AuditAction("cards.lookup", { resourceType: "VerificationCard" })
  async lookup(@CurrentAdmin() admin: AdminContext, @Req() request: Request, @Body() body: { token?: string; cardNumber?: string }) {
    await this.limits.consume("cardLookupPerStaff", admin.user.id);
    return this.cards.lookup(admin, body ?? {}, request.ip);
  }
}

/** Keystone: verifier accounts (card lookups only), created on request. */
@Controller("v1/admin/verifiers")
@UseGuards(AdminAccessGuard)
export class VerifiersController {
  constructor(@Inject(CardLookupService) private readonly cards: CardLookupService) {}

  @Get()
  @RequirePermission("verifiers.manage")
  @AuditAction("verifiers.list")
  list(@Query() query: { page?: string; limit?: string }) {
    return this.cards.listVerifiers(pageOf(query));
  }

  @Post()
  @RequirePermission("verifiers.manage")
  @RecentSignIn()
  @AuditAction("verifiers.create")
  create(@CurrentAdmin() admin: AdminContext, @Body() body: Record<string, unknown>) {
    return this.cards.createVerifier(admin, body ?? {});
  }

  @Patch(":userId")
  @RequirePermission("verifiers.manage")
  @RecentSignIn()
  @AuditAction("verifiers.update")
  update(@CurrentAdmin() admin: AdminContext, @Param("userId") userId: string, @Body() body: { level?: string; expiresAt?: string | null }) {
    return this.cards.updateVerifier(admin, id(userId, "userId"), body ?? {});
  }

  @Post(":userId/cards")
  @RequirePermission("verifiers.manage")
  @RecentSignIn()
  @AuditAction("verifiers.cards.grant")
  grantCards(@CurrentAdmin() admin: AdminContext, @Param("userId") userId: string, @Body() body: { cardNumbers?: string[] }) {
    return this.cards.grantCards(admin, id(userId, "userId"), body ?? {});
  }

  @Delete(":userId/cards/:cardId")
  @RequirePermission("verifiers.manage")
  @RecentSignIn()
  @AuditAction("verifiers.cards.remove")
  removeCard(@CurrentAdmin() admin: AdminContext, @Param("userId") userId: string, @Param("cardId") cardId: string) {
    return this.cards.removeCard(admin, id(userId, "userId"), id(cardId, "cardId"));
  }

  @Post(":userId/revoke")
  @HttpCode(200)
  @RequirePermission("verifiers.manage")
  @RecentSignIn()
  @AuditAction("verifiers.revoke")
  revoke(@CurrentAdmin() admin: AdminContext, @Param("userId") userId: string) {
    return this.cards.revokeVerifier(admin, id(userId, "userId"));
  }

  @Get(":userId/lookups")
  @RequirePermission("verifiers.manage")
  @AuditAction("verifiers.lookups.list", { resourceType: "PortalUser", resourceParam: "userId" })
  lookups(@Param("userId") userId: string, @Query() query: { page?: string; limit?: string }) {
    return this.cards.lookups(id(userId, "userId"), pageOf(query));
  }
}
