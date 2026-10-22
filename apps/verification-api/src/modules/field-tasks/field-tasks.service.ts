import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma, type FieldTask } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../../common/database/prisma.service";
import type { ApplicationSchema } from "../../domain/verification.types";
import { SYSTEM_ROLES } from "../admin-access/admin-permissions";
import { VerificationStore } from "../verifications/verification.repository";
import { FieldEvidenceService } from "./field-evidence.service";
import {
  ArriveInput,
  AssignFieldTaskInput,
  FIELD_TASK_OUTCOMES,
  FIELD_TASK_VIEWS,
  FIELD_TASK_VERIFICATION_TYPES,
  FieldTaskOutcome,
  FieldTaskView,
  OPEN_FIELD_TASK_STATUSES,
  OUTCOME_RESOLUTION,
  SubmitFieldTaskInput
} from "./field-tasks.types";

// Vendor roles that can do visits (hold field.tasks.perform there).
const AGENT_ROLE_KEYS = SYSTEM_ROLES.filter((role) => role.scope === "VENDOR" && role.permissions.includes("field.tasks.perform")).map((role) => role.key);

const MANAGER_INCLUDE = { vendor: { select: { id: true, name: true } }, assignedTo: { select: { id: true, displayName: true } } } satisfies Prisma.FieldTaskInclude;
type ManagedTask = Prisma.FieldTaskGetPayload<{ include: typeof MANAGER_INCLUDE }>;

const OPEN: Prisma.FieldTaskWhereInput = { status: { in: [...OPEN_FIELD_TASK_STATUSES] } };

function viewWhere(view: FieldTaskView, now: Date): Prisma.FieldTaskWhereInput {
  if (view === "open") return OPEN;
  if (view === "overdue") return { ...OPEN, dueAt: { lt: now } };
  if (view === "completed") return { status: "SUBMITTED" };
  return { status: "CANCELLED" };
}

/** When a new visit is due: FIELD_TASK_DUE_DAYS after it is created (default 3). */
function defaultDueAt(now = new Date()): Date {
  const days = Number(process.env.FIELD_TASK_DUE_DAYS ?? 3);
  return new Date(now.getTime() + (Number.isFinite(days) && days > 0 ? days : 3) * 86_400_000);
}

const isOverdue = (task: FieldTask, now = new Date()) =>
  Boolean(task.dueAt && task.dueAt < now && (OPEN_FIELD_TASK_STATUSES as readonly string[]).includes(task.status));

/** A field agent acting for one vendor (field.tasks.perform at that vendor). */
export interface FieldAgent {
  userId: string;
  vendorId: string;
}

/**
 * Field tasks. Keystone hands each task to a vendor; that vendor's agents see it in their pool,
 * accept it, visit and submit. An agent never sees another vendor's tasks or a task with no vendor.
 */
@Injectable()
export class FieldTasksService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(VerificationStore) private readonly verifications: VerificationStore,
    @Inject(FieldEvidenceService) private readonly evidence: FieldEvidenceService
  ) {}

  // Create a field task for any physical-address check that is awaiting a field visit
  // and does not already have a task. Runs before tasks are listed so newly created
  // cases surface without a separate provisioning job.
  async syncPendingTasks(): Promise<void> {
    const pending = await this.prisma.verification.findMany({
      where: {
        type: { in: [...FIELD_TASK_VERIFICATION_TYPES] },
        status: "MANUAL_REVIEW",
        fieldTask: { is: null }
      },
      include: { application: true }
    });

    for (const verification of pending) {
      const data = (verification.application.data as unknown as ApplicationSchema) || undefined;
      const workerName = data?.personal?.nameAsAadhaar?.trim() || "Worker";
      const addressText = data?.personal?.submittedAddress?.trim() || "Address on file";
      await this.prisma.fieldTask.upsert({
        where: { verificationId: verification.id },
        update: {},
        create: {
          id: `ftask_${randomUUID()}`,
          tenantId: verification.application.tenantId,
          clientId: verification.application.clientId,
          applicationId: verification.applicationId,
          verificationId: verification.id,
          status: "PENDING_ASSIGNMENT",
          taskType: "ADDRESS_VERIFICATION",
          dueAt: defaultDueAt(),
          workerName,
          addressText
        }
      });
    }
  }

  async listForAgent(agent: FieldAgent) {
    const mine = await this.prisma.fieldTask.findMany({
      where: { ...this.assignedScope(agent), assignedToUserId: agent.userId, status: { notIn: ["CANCELLED"] } },
      orderBy: [{ dueAt: "asc" }, { createdAt: "asc" }]
    });
    const available = await this.prisma.fieldTask.findMany({
      where: { ...this.poolScope(agent), assignedToUserId: null, status: "PENDING_ASSIGNMENT" },
      orderBy: [{ dueAt: "asc" }, { createdAt: "asc" }]
    });
    return {
      open: mine.filter((task) => task.status !== "SUBMITTED").map((t) => this.toListItem(t)),
      available: available.map((t) => this.toListItem(t)),
      submitted: mine.filter((task) => task.status === "SUBMITTED").map((t) => this.toListItem(t))
    };
  }

  async getForAgent(agent: FieldAgent, taskId: string) {
    const task = await this.viewableTask(agent, taskId);
    return { ...this.toDetail(task), evidence: task.assignedToUserId === agent.userId ? await this.evidence.forTask(task) : [] };
  }

  async accept(agent: FieldAgent, taskId: string) {
    const task = await this.viewableTask(agent, taskId);
    if (task.assignedToUserId === agent.userId && (task.status === "ACCEPTED" || task.status === "IN_PROGRESS")) return this.toDetail(task);
    if (!["PENDING_ASSIGNMENT", "ASSIGNED"].includes(task.status)) throw new BadRequestException("Task is not available for acceptance");
    const changed = await this.prisma.fieldTask.updateMany({ where: { id: task.id, tenantId: task.tenantId, clientId: task.clientId, status: task.status, assignedToUserId: task.assignedToUserId }, data: { status: "ACCEPTED", assignedToUserId: agent.userId, acceptedAt: new Date(), rejectionReason: null } });
    if (!changed.count) throw new ConflictException("Task was accepted or changed by another agent");
    const updated = await this.ownedTask(agent, task.id);
    return this.toDetail(updated);
  }

  async reject(agent: FieldAgent, taskId: string, reason: string) {
    const trimmed = String(reason || "").trim();
    if (trimmed.length < 3 || trimmed.length > 300) {
      throw new BadRequestException("A rejection reason of 3 to 300 characters is required");
    }
    const task = await this.ownedTask(agent, taskId);
    if (task.status === "SUBMITTED") throw new BadRequestException("A submitted task cannot be rejected");
    // Return the task to the allocation pool (PRD section 14.2).
    const updated = await this.prisma.fieldTask.update({
      where: { id: task.id, tenantId: task.tenantId, clientId: task.clientId, assignedToUserId: agent.userId, status: task.status },
      data: { status: "PENDING_ASSIGNMENT", assignedToUserId: null, acceptedAt: null, rejectionReason: trimmed }
    });
    return this.toDetail(updated);
  }

  async arrive(agent: FieldAgent, taskId: string, input: ArriveInput) {
    const task = await this.ownedTask(agent, taskId);
    if (task.status !== "ACCEPTED" && task.status !== "IN_PROGRESS") {
      throw new BadRequestException("Accept the task before recording arrival");
    }
    const latitude = this.coordinate(input.latitude, "latitude", 90);
    const longitude = this.coordinate(input.longitude, "longitude", 180);
    const updated = await this.prisma.fieldTask.update({
      where: { id: task.id, tenantId: task.tenantId, clientId: task.clientId, assignedToUserId: agent.userId, status: task.status },
      data: { status: "IN_PROGRESS", arrivedAt: new Date(), arriveLatitude: latitude, arriveLongitude: longitude }
    });
    return this.toDetail(updated);
  }

  async submit(agent: FieldAgent, taskId: string, input: SubmitFieldTaskInput) {
    const task = await this.ownedTask(agent, taskId);
    if (task.status !== "IN_PROGRESS" && task.status !== "ACCEPTED") {
      throw new BadRequestException("Only an accepted or in-progress task can be submitted");
    }
    const outcome = String(input.outcome || "").trim().toUpperCase() as FieldTaskOutcome;
    if (!FIELD_TASK_OUTCOMES.includes(outcome)) {
      throw new BadRequestException(`outcome must be one of: ${FIELD_TASK_OUTCOMES.join(", ")}`);
    }
    const notes = String(input.notes || "").trim();
    if (notes.length > 1000) throw new BadRequestException("notes must be 1000 characters or fewer");
    const resolution = OUTCOME_RESOLUTION[outcome];
    const evidenceItems = await this.evidence.forSubmission(task, agent.userId, outcome);

    if (resolution === "REVISIT") {
      const updated = await this.prisma.fieldTask.update({
        where: { id: task.id, tenantId: task.tenantId, clientId: task.clientId, assignedToUserId: agent.userId, status: task.status },
        data: { status: "ACCEPTED", outcome, notes: notes || null }
      });
      return this.toDetail(updated);
    }

    const evidence = {
      source: "field-visit",
      outcome,
      notes: notes || undefined,
      agentId: agent.userId,
      evidence: evidenceItems,
      arrivedAt: task.arrivedAt?.toISOString(),
      location:
        task.arriveLatitude != null && task.arriveLongitude != null
          ? { latitude: task.arriveLatitude, longitude: task.arriveLongitude }
          : undefined,
      submittedAt: new Date().toISOString()
    };

    const updated = await this.prisma.$transaction(async tx => {
      const submitted = await tx.fieldTask.update({ where: { id: task.id, tenantId: task.tenantId, clientId: task.clientId, assignedToUserId: agent.userId, status: task.status }, data: { status: "SUBMITTED", outcome, notes: notes || null, submittedAt: new Date() } });
      // The vendor supplies findings. An authorized QA decision clears the case.
      // Field evidence is never counted as a successful external API invocation.
      await tx.verification.update({ where: { id: task.verificationId, applicationId: task.applicationId, application: { tenantId: task.tenantId, clientId: task.clientId } }, data: { status: "MANUAL_REVIEW", result: { ...evidence, qaRequired: true }, completedAt: new Date() } });
      return submitted;
    });
    await this.verifications.recalculateApplicationStatus(task.applicationId, { tenantId: task.tenantId, clientId: task.clientId });
    return this.toDetail(updated);
  }

  private async ownedTask(agent: FieldAgent, taskId: string): Promise<FieldTask> {
    const task = await this.prisma.fieldTask.findFirst({ where: { ...this.assignedScope(agent), id: taskId, assignedToUserId: agent.userId } });
    if (!task) throw new NotFoundException("Task not found");
    return task;
  }

  // A task the agent may view or accept: already theirs, or unassigned in their vendor's pool.
  // Keeps one vendor's (and one partner's) worker PII away from every other vendor's agents.
  private async viewableTask(agent: FieldAgent, taskId: string): Promise<FieldTask> {
    const task = await this.prisma.fieldTask.findFirst({
      where: {
        id: taskId,
        OR: [
          { ...this.assignedScope(agent), assignedToUserId: agent.userId },
          { assignedToUserId: null, ...this.poolScope(agent) }
        ]
      }
    });
    if (!task) throw new NotFoundException("Task not found");
    return task;
  }

  // The vendor's open pool: tasks Keystone gave this vendor that no agent has taken yet.
  private poolScope(agent: FieldAgent): { vendorId: string } {
    return { vendorId: agent.vendorId };
  }

  // An agent's own tasks stay within the vendor they act for.
  private assignedScope(agent: FieldAgent): { vendorId: string } {
    return { vendorId: agent.vendorId };
  }

  /**
   * Keystone (every vendor) or a vendor admin (their vendor): the assignment board. `view` picks
   * open, overdue (open past its due date), completed (submitted) or cancelled tasks; `counts`
   * has each, plus open tasks with no vendor yet and with no agent yet.
   */
  async listForManager(vendorId: string | null, filter: { status?: string; unassigned?: boolean; view?: string }) {
    const view = filter.view?.toLowerCase();
    if (view && !(FIELD_TASK_VIEWS as readonly string[]).includes(view)) throw new BadRequestException(`view must be one of ${FIELD_TASK_VIEWS.join(", ")}`);
    await this.syncPendingTasks();
    const now = new Date();
    const scope: Prisma.FieldTaskWhereInput = vendorId ? { vendorId } : {};
    const tasks = await this.prisma.fieldTask.findMany({
      where: {
        ...scope,
        ...(filter.unassigned ? { vendorId: null } : {}),
        ...(filter.status ? { status: filter.status } : {}),
        ...(view ? viewWhere(view as FieldTaskView, now) : {})
      },
      orderBy: [{ dueAt: "asc" }, { createdAt: "asc" }],
      take: 500,
      include: MANAGER_INCLUDE
    });
    const count = (where: Prisma.FieldTaskWhereInput) => this.prisma.fieldTask.count({ where: { AND: [scope, where] } });
    const [open, overdue, completed, cancelled, noVendor, noAgent] = await Promise.all([
      count(viewWhere("open", now)), count(viewWhere("overdue", now)), count(viewWhere("completed", now)), count(viewWhere("cancelled", now)),
      count({ ...OPEN, vendorId: null }), count({ ...OPEN, assignedToUserId: null })
    ]);
    return { counts: { open, overdue, completed, cancelled, noVendor, noAgent }, items: tasks.map((task) => this.toManagerItem(task, now)) };
  }

  /**
   * Keystone gives a task to a vendor, an agent at that vendor, or both, and sets its due date
   * (Keystone's own field team is a vendor like any other). A vendor admin gives their vendor's
   * tasks to their own agents. Giving a task to someone else starts it over: the new agent
   * accepts it and records their own arrival. Keystone brings a cancelled task back the same way.
   * A submitted visit is sent back instead.
   */
  async assign(managerVendorId: string | null, taskId: string, input: AssignFieldTaskInput) {
    const keystone = managerVendorId === null;
    const task = await this.prisma.fieldTask.findFirst({ where: { id: taskId, ...(keystone ? {} : { vendorId: managerVendorId }) } });
    if (!task) throw new NotFoundException("Task not found");
    if (!keystone && (input.vendorId !== undefined || input.dueAt !== undefined)) throw new ForbiddenException("Only Keystone changes the vendor or the due date");
    if (task.status === "SUBMITTED") throw new ConflictException("This visit is submitted. Send it back for another visit instead.");
    if (task.status === "CANCELLED" && !keystone) throw new ConflictException("This visit was cancelled");

    const vendorId = input.vendorId === undefined ? task.vendorId : input.vendorId;
    if (vendorId && vendorId !== task.vendorId) {
      const vendor = await this.prisma.vendor.findUnique({ where: { id: vendorId }, select: { status: true } });
      if (!vendor || vendor.status !== "ACTIVE") throw new NotFoundException("Vendor not found or disabled");
    }
    // A new vendor means a new agent: the old one no longer sees the task.
    const agentId = input.agentId !== undefined ? input.agentId : vendorId === task.vendorId ? task.assignedToUserId : null;
    if (agentId && (agentId !== task.assignedToUserId || vendorId !== task.vendorId)) {
      if (!vendorId) throw new BadRequestException("Choose the vendor before the agent");
      await this.assertAgent(vendorId, agentId);
    }
    if (input.dueAt && input.dueAt.getTime() <= Date.now()) throw new BadRequestException("The due date must be in the future");

    const moved = task.status === "CANCELLED" || vendorId !== task.vendorId || agentId !== task.assignedToUserId;
    const changed = await this.prisma.fieldTask.updateMany({
      where: { id: task.id, status: task.status, vendorId: task.vendorId, assignedToUserId: task.assignedToUserId },
      data: {
        vendorId,
        ...(input.dueAt !== undefined ? { dueAt: input.dueAt } : {}),
        ...(moved
          ? {
              assignedToUserId: agentId, status: agentId ? "ASSIGNED" : "PENDING_ASSIGNMENT", assignedAt: agentId ? new Date() : null,
              acceptedAt: null, arrivedAt: null, arriveLatitude: null, arriveLongitude: null, rejectionReason: null, cancelledAt: null, cancelReason: null
            }
          : {})
      }
    });
    if (!changed.count) throw new ConflictException("This task changed. Reload and try again.");
    return this.toManagerDetail(await this.prisma.fieldTask.findUniqueOrThrow({ where: { id: task.id }, include: MANAGER_INCLUDE }));
  }

  /** Keystone cancels a visit that is not submitted. The check stays in review, to decide without it. */
  async cancel(taskId: string, reasonValue: unknown) {
    const reason = String(reasonValue ?? "").trim();
    if (reason.length < 3 || reason.length > 300) throw new BadRequestException("Say why, in 3 to 300 characters");
    const task = await this.prisma.fieldTask.findUnique({ where: { id: taskId } });
    if (!task) throw new NotFoundException("Task not found");
    if (task.status === "CANCELLED") throw new ConflictException("This visit is already cancelled");
    if (task.status === "SUBMITTED") throw new ConflictException("This visit is submitted. Decide the check or send the visit back.");
    const changed = await this.prisma.fieldTask.updateMany({ where: { id: task.id, status: task.status }, data: { status: "CANCELLED", cancelledAt: new Date(), cancelReason: reason } });
    if (!changed.count) throw new ConflictException("This task changed. Reload and try again.");
    return this.toManagerDetail(await this.prisma.fieldTask.findUniqueOrThrow({ where: { id: task.id }, include: MANAGER_INCLUDE }));
  }

  // The person must do visits for this vendor, on an active account.
  private async assertAgent(vendorId: string, userId: string) {
    const binding = await this.prisma.staffRoleBinding.findFirst({ where: { userId, scopeType: "VENDOR", vendorId, roleKey: { in: AGENT_ROLE_KEYS }, user: { status: "ACTIVE" } }, select: { id: true } });
    if (!binding) throw new BadRequestException("This person is not an active agent at the vendor");
  }

  /** Keystone hands a task to a vendor (or takes it back with null). Only while no agent has accepted it. */
  async assignVendor(taskId: string, vendorId: string | null) {
    if (vendorId) {
      const vendor = await this.prisma.vendor.findUnique({ where: { id: vendorId }, select: { status: true } });
      if (!vendor || vendor.status !== "ACTIVE") throw new NotFoundException("Vendor not found or disabled");
    }
    const changed = await this.prisma.fieldTask.updateMany({ where: { id: taskId, assignedToUserId: null, status: "PENDING_ASSIGNMENT" }, data: { vendorId } });
    if (!changed.count) {
      const exists = await this.prisma.fieldTask.count({ where: { id: taskId } });
      if (!exists) throw new NotFoundException("Task not found");
      throw new ConflictException("An agent already has this task");
    }
    return this.toDetail(await this.prisma.fieldTask.findUniqueOrThrow({ where: { id: taskId } }));
  }

  /**
   * Keystone sends a submitted visit back for another one: to the same agent when they still
   * have it, else back to the vendor's pool. The earlier attempt is kept in the task's history,
   * the arrival is cleared so the next visit records its own, and the check stays in review.
   */
  async sendBack(taskId: string, noteValue: unknown) {
    const note = String(noteValue ?? "").trim();
    if (note.length < 5 || note.length > 500) throw new BadRequestException("Say what to check again, in 5 to 500 characters");
    const task = await this.prisma.fieldTask.findUnique({ where: { id: taskId } });
    if (!task) throw new NotFoundException("Task not found");
    if (task.status !== "SUBMITTED") throw new ConflictException("Only a submitted visit can be sent back");
    const now = new Date();
    const attempt = {
      outcome: task.outcome,
      notes: task.notes,
      arrivedAt: task.arrivedAt?.toISOString() ?? null,
      location: task.arriveLatitude != null && task.arriveLongitude != null ? { latitude: task.arriveLatitude, longitude: task.arriveLongitude } : null,
      submittedAt: task.submittedAt?.toISOString() ?? null,
      evidenceIds: await this.evidence.attemptIds(task),
      returnedAt: now.toISOString(),
      reviewNote: note
    };
    const history = [...(Array.isArray(task.history) ? (task.history as Prisma.JsonArray) : []), attempt];
    const updated = await this.prisma.$transaction(async (tx) => {
      const changed = await tx.fieldTask.updateMany({
        where: { id: task.id, status: "SUBMITTED" },
        data: {
          status: task.assignedToUserId ? "ACCEPTED" : "PENDING_ASSIGNMENT",
          outcome: null, notes: null, submittedAt: null, arrivedAt: null, arriveLatitude: null, arriveLongitude: null,
          reviewNote: note, returnedAt: now, returnCount: { increment: 1 }, history: history as Prisma.InputJsonValue
        }
      });
      if (!changed.count) throw new ConflictException("This visit changed. Reload and try again.");
      // The check waits for the next visit: still in review, but no longer ready to decide.
      await tx.verification.update({ where: { id: task.verificationId }, data: { result: { source: "field-visit", awaitingRevisit: true, reviewNote: note }, completedAt: null } });
      return tx.fieldTask.findUniqueOrThrow({ where: { id: task.id } });
    });
    await this.verifications.recalculateApplicationStatus(task.applicationId, { tenantId: task.tenantId, clientId: task.clientId });
    return this.toDetail(updated);
  }

  private coordinate(value: number | undefined, label: string, bound: number): number | null {
    if (value === undefined || value === null) return null;
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || Math.abs(numeric) > bound) {
      throw new BadRequestException(`${label} is out of range`);
    }
    return numeric;
  }

  private maskName(name: string): string {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    if (parts.length <= 1) return parts[0] || "Worker";
    return `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`;
  }

  private toListItem(task: FieldTask) {
    return {
      id: task.id,
      task_type: task.taskType,
      status: task.status,
      worker_name: this.maskName(task.workerName),
      address_text: task.addressText,
      due_at: task.dueAt?.toISOString() || null,
      overdue: isOverdue(task),
      created_at: task.createdAt.toISOString()
    };
  }

  private toManagerItem(task: ManagedTask, now = new Date()) {
    return { ...this.toListItem(task), overdue: isOverdue(task, now), vendor: task.vendor, agent: task.assignedTo, assigned_at: task.assignedAt?.toISOString() || null };
  }

  private toManagerDetail(task: ManagedTask) {
    return { ...this.toDetail(task), vendor: task.vendor, agent: task.assignedTo };
  }

  private toDetail(task: FieldTask) {
    return {
      ...this.toListItem(task),
      instructions: task.instructions,
      outcome: task.outcome,
      notes: task.notes,
      rejection_reason: task.rejectionReason,
      accepted_at: task.acceptedAt?.toISOString() || null,
      arrived_at: task.arrivedAt?.toISOString() || null,
      arrival_location:
        task.arriveLatitude != null && task.arriveLongitude != null
          ? { latitude: task.arriveLatitude, longitude: task.arriveLongitude }
          : null,
      submitted_at: task.submittedAt?.toISOString() || null,
      assigned_at: task.assignedAt?.toISOString() || null,
      cancelled_at: task.cancelledAt?.toISOString() || null,
      cancel_reason: task.cancelReason,
      // Set when Keystone sent an earlier submission back: what to check again, and the earlier attempts.
      review_note: task.reviewNote,
      returned_at: task.returnedAt?.toISOString() || null,
      return_count: task.returnCount,
      previous_attempts: Array.isArray(task.history) ? task.history : []
    };
  }
}

