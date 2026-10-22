import { Controller, Get, Inject, Query, UseGuards } from "@nestjs/common";
import { AdminAccessGuard } from "../admin-access/admin-access.guard";
import { AdminContext, AuditAction, CurrentAdmin, RequirePermission } from "../admin-access/admin-context";
import { ReviewQueueQuery, ReviewQueueService } from "./review-queue.service";

/**
 * Control's review queue: checks waiting on a Keystone reviewer across every partner (or one,
 * with x-partner-id). ?ready=false also lists field visits not yet submitted; ?type= one check type.
 * Decide with POST /v1/admin/cases/:caseId/checks/:checkId/decision, or send a field visit back
 * with POST /v1/admin/field-tasks/:taskId/send-back.
 */
@Controller("v1/admin/review-queue")
@UseGuards(AdminAccessGuard)
export class ReviewQueueController {
  constructor(@Inject(ReviewQueueService) private readonly queue: ReviewQueueService) {}

  @Get()
  @RequirePermission("cases.decide", { allPartners: true })
  @AuditAction("cases.review_queue")
  list(@CurrentAdmin() admin: AdminContext, @Query() query: ReviewQueueQuery) {
    return this.queue.list(admin, query ?? {});
  }
}
