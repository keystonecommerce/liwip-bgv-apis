import { Inject, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../common/database/prisma.service";
import { AdminContext, partnerDb } from "../admin-access/admin-context";
import { categoryOf, workerName } from "../cards/card-views";
import { maskPhone, text } from "./input";

export interface ReviewQueueQuery { ready?: string; type?: string }

const QUEUE_INCLUDE = {
  application: {
    select: {
      id: true, data: true, workerPhone: true, status: true,
      tenant: { select: { id: true, name: true } },
      client: { select: { id: true, name: true } }
    }
  },
  fieldTask: {
    select: { id: true, status: true, outcome: true, submittedAt: true, returnCount: true, dueAt: true, cancelReason: true, vendor: { select: { id: true, name: true } }, _count: { select: { evidence: { where: { deletedAt: null } } } } }
  }
} satisfies Prisma.VerificationInclude;

const READY_TASK_STATUSES = ["SUBMITTED", "CANCELLED"] as const;

type QueueRow = Prisma.VerificationGetPayload<{ include: typeof QUEUE_INCLUDE }>;

/** Why a check is waiting on a reviewer, in words a reviewer reads. Never a raw status. */
function reasonOf(row: QueueRow): string {
  const task = row.fieldTask;
  if (task) {
    if (task.status === "SUBMITTED") return task.returnCount ? "Field visit submitted again" : "Field visit submitted";
    if (task.status === "CANCELLED") return task.cancelReason ? `Field visit cancelled: ${task.cancelReason}` : "Field visit cancelled";
    return task.returnCount ? "Sent back; waiting for the next visit" : "Waiting for the field visit";
  }
  const result = (row.result ?? {}) as { reason?: unknown };
  if (typeof result.reason === "string" && result.reason.trim()) return result.reason.trim();
  return row.failureReason?.trim() || "Needs a reviewer";
}

/**
 * Checks waiting on a Keystone reviewer, oldest first: field visits, court matches and anything
 * else in review. A field visit is ready to decide once the agent has submitted it, or once
 * Keystone has cancelled it and the check is decided without it.
 */
@Injectable()
export class ReviewQueueService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async list(admin: AdminContext, query: ReviewQueueQuery) {
    const readyOnly = query.ready === undefined ? true : query.ready !== "false";
    const type = query.type ? text(query.type, "type", 40).toUpperCase() : undefined;
    const rows = await partnerDb(this.prisma, admin).verification.findMany({
      where: {
        status: "MANUAL_REVIEW",
        application: { status: { not: "ARCHIVED" } },
        ...(type ? { type } : {}),
        ...(readyOnly ? { OR: [{ fieldTask: { is: null } }, { fieldTask: { is: { status: { in: [...READY_TASK_STATUSES] } } } }] } : {})
      },
      include: QUEUE_INCLUDE,
      orderBy: { updatedAt: "asc" },
      take: 200
    });
    return {
      items: (rows as QueueRow[]).map((row) => ({
        checkId: row.id,
        type: row.type,
        category: categoryOf(row.type),
        caseId: row.applicationId,
        worker: { name: workerName(row.application.data), phoneLast4: maskPhone(row.application.workerPhone) },
        partner: row.application.tenant,
        program: row.application.client,
        reason: reasonOf(row),
        ready: !row.fieldTask || (READY_TASK_STATUSES as readonly string[]).includes(row.fieldTask.status),
        inReviewSince: row.updatedAt.toISOString(),
        fieldVisit: row.fieldTask
          ? {
              taskId: row.fieldTask.id,
              outcome: row.fieldTask.outcome,
              submittedAt: row.fieldTask.submittedAt?.toISOString() ?? null,
              dueAt: row.fieldTask.dueAt?.toISOString() ?? null,
              timesSentBack: row.fieldTask.returnCount,
              evidenceCount: row.fieldTask._count.evidence,
              vendor: row.fieldTask.vendor
            }
          : null
      }))
    };
  }
}
