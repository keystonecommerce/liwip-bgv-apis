import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma, type FieldTask } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../../common/database/prisma.service";
import type { ApplicationSchema } from "../../domain/verification.types";
import { VerificationStore } from "../verifications/verification.repository";
import {
  ArriveInput,
  FIELD_TASK_OUTCOMES,
  FIELD_TASK_VERIFICATION_TYPES,
  FieldTaskOutcome,
  OUTCOME_RESOLUTION,
  SubmitFieldTaskInput
} from "./field-tasks.types";

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
    @Inject(VerificationStore) private readonly verifications: VerificationStore
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
    return this.toDetail(task);
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

  /** Keystone (every vendor) or a vendor admin (their vendor): the task list with its state. */
  async listForManager(vendorId: string | null, filter: { status?: string; unassigned?: boolean }) {
    await this.syncPendingTasks();
    const tasks = await this.prisma.fieldTask.findMany({
      where: {
        ...(vendorId ? { vendorId } : {}),
        ...(filter.unassigned ? { vendorId: null } : {}),
        ...(filter.status ? { status: filter.status } : {})
      },
      orderBy: [{ dueAt: "asc" }, { createdAt: "asc" }],
      take: 500,
      include: { vendor: { select: { id: true, name: true } }, assignedTo: { select: { id: true, displayName: true } } }
    });
    return { items: tasks.map((task) => ({ ...this.toListItem(task), vendor: task.vendor, agent: task.assignedTo })) };
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
      created_at: task.createdAt.toISOString()
    };
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
      // Set when Keystone sent an earlier submission back: what to check again, and the earlier attempts.
      review_note: task.reviewNote,
      returned_at: task.returnedAt?.toISOString() || null,
      return_count: task.returnCount,
      previous_attempts: Array.isArray(task.history) ? task.history : []
    };
  }
}

