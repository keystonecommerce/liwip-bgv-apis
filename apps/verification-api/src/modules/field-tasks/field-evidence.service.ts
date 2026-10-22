import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { FieldEvidence, FieldTask } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../../common/database/prisma.service";
import { FieldEvidenceStorage } from "./field-evidence.storage";
import { EVIDENCE_KINDS, EvidenceKind, FieldTaskOutcome, OUTCOME_RESOLUTION } from "./field-tasks.types";

export interface EvidenceUpload { buffer: Buffer; originalname: string; mimetype: string; size: number }

export const MAX_EVIDENCE_BYTES = 10 * 1024 * 1024;
const MAX_EVIDENCE_PER_VISIT = 20;

// Images only, checked by their first bytes as well as the declared type.
const IMAGE_SIGNATURES: Record<string, (bytes: Buffer) => boolean> = {
  "image/jpeg": (bytes) => bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
  "image/png": (bytes) => bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  "image/webp": (bytes) => bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP"
};

// Outcomes where someone was met and signs for the visit.
const SIGNED_OUTCOMES: readonly FieldTaskOutcome[] = ["PERSON_MET", "FAMILY_MET"];

/** Who is looking: Keystone (vendorId null), a vendor's admin, or one of its agents. */
export interface EvidenceViewer { vendorId: string | null; userId: string; manager: boolean }

/**
 * Photos and signatures from a field visit. The agent adds them while the visit is open; a photo
 * carries the GPS location where it was taken. Submitting a visit needs a photo, and a signature
 * when the person or their family was met. After a send-back the next visit needs its own.
 */
@Injectable()
export class FieldEvidenceService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(FieldEvidenceStorage) private readonly storage: FieldEvidenceStorage
  ) {}

  async upload(agent: { userId: string; vendorId: string }, taskId: string, input: Record<string, unknown>, file?: EvidenceUpload) {
    const task = await this.agentTask(agent, taskId);
    const kind = String(input.kind ?? "").trim().toUpperCase() as EvidenceKind;
    if (!EVIDENCE_KINDS.includes(kind)) throw new BadRequestException(`kind must be one of ${EVIDENCE_KINDS.join(", ")}`);
    const contentType = String(file?.mimetype || "").toLowerCase();
    const sniff = IMAGE_SIGNATURES[contentType];
    if (!file || !sniff || !sniff(file.buffer) || file.size > MAX_EVIDENCE_BYTES) throw new BadRequestException("Add a JPEG, PNG or WebP image up to 10 MB");
    const latitude = coordinate(input.latitude, "latitude", 90);
    const longitude = coordinate(input.longitude, "longitude", 180);
    if ((latitude === null) !== (longitude === null)) throw new BadRequestException("Send both latitude and longitude");
    if (kind === "PHOTO" && latitude === null) throw new BadRequestException("Photos need the GPS location where they were taken");
    const capturedAt = input.capturedAt === undefined || input.capturedAt === "" ? new Date() : new Date(String(input.capturedAt));
    if (Number.isNaN(capturedAt.getTime()) || capturedAt.getTime() > Date.now() + 5 * 60_000) throw new BadRequestException("capturedAt must be a past date");
    if ((await this.prisma.fieldEvidence.count({ where: this.currentAttempt(task, agent.userId) })) >= MAX_EVIDENCE_PER_VISIT) {
      throw new BadRequestException(`A visit can have up to ${MAX_EVIDENCE_PER_VISIT} photos and signatures`);
    }

    const id = `fev_${randomUUID()}`;
    const objectKey = `field-evidence/tenants/${task.tenantId}/clients/${task.clientId}/tasks/${task.id}/${id}`;
    const bucket = await this.storage.put(objectKey, file.buffer, contentType);
    const evidence = await this.prisma.fieldEvidence.create({
      data: {
        id, fieldTaskId: task.id, tenantId: task.tenantId, clientId: task.clientId, kind, status: "UPLOADED", bucket, objectKey,
        originalFileName: safeFileName(file.originalname) || `${kind.toLowerCase()}.${contentType.split("/")[1]}`,
        contentType, declaredSizeBytes: file.size, sizeBytes: file.buffer.length,
        capturedLatitude: latitude, capturedLongitude: longitude, capturedAt, uploadedAt: new Date(), uploadedByUserId: agent.userId
      }
    });
    return this.toEvidence(evidence, task);
  }

  /** The agent takes back a photo or signature from the visit they are on. */
  async remove(agent: { userId: string; vendorId: string }, taskId: string, evidenceId: string) {
    const task = await this.agentTask(agent, taskId);
    const changed = await this.prisma.fieldEvidence.updateMany({ where: { id: evidenceId, ...this.currentAttempt(task, agent.userId) }, data: { status: "DELETED", deletedAt: new Date() } });
    if (!changed.count) throw new NotFoundException("Evidence not found on this visit");
    return { removed: evidenceId };
  }

  async list(viewer: EvidenceViewer, taskId: string) {
    const task = await this.viewableTask(viewer, taskId);
    return { items: await this.forTask(task) };
  }

  async file(viewer: EvidenceViewer, taskId: string, evidenceId: string) {
    const task = await this.viewableTask(viewer, taskId);
    const evidence = await this.prisma.fieldEvidence.findFirst({ where: { id: evidenceId, fieldTaskId: task.id, deletedAt: null } });
    if (!evidence) throw new NotFoundException("Evidence not found");
    return { bytes: await this.storage.get(evidence.bucket, evidence.objectKey), contentType: evidence.contentType };
  }

  /** Every photo and signature on the task, the current visit's marked as such. */
  async forTask(task: FieldTask) {
    const rows = await this.prisma.fieldEvidence.findMany({ where: { fieldTaskId: task.id, deletedAt: null }, orderBy: { createdAt: "asc" } });
    return rows.map((row) => this.toEvidence(row, task));
  }

  /**
   * The current visit's evidence, checked against what the outcome needs. Throws when it is
   * missing; returns what the submission records.
   */
  async forSubmission(task: FieldTask, agentUserId: string, outcome: FieldTaskOutcome) {
    const rows = await this.prisma.fieldEvidence.findMany({ where: this.currentAttempt(task, agentUserId), orderBy: { createdAt: "asc" } });
    if (OUTCOME_RESOLUTION[outcome] !== "REVISIT") {
      if (!rows.some((row) => row.kind === "PHOTO")) throw new BadRequestException("Add at least one photo of the address before submitting");
      if (SIGNED_OUTCOMES.includes(outcome) && !rows.some((row) => row.kind === "SIGNATURE")) throw new BadRequestException("Add the signature of the person you met");
    }
    return rows.map((row) => ({
      id: row.id, kind: row.kind, capturedAt: row.capturedAt?.toISOString() ?? null,
      location: row.capturedLatitude != null && row.capturedLongitude != null ? { latitude: row.capturedLatitude, longitude: row.capturedLongitude } : null
    }));
  }

  /** The ids of the evidence on the visit just submitted, kept with it when it is sent back. */
  async attemptIds(task: FieldTask): Promise<string[]> {
    if (!task.assignedToUserId) return [];
    const rows = await this.prisma.fieldEvidence.findMany({ where: this.currentAttempt(task, task.assignedToUserId), select: { id: true }, orderBy: { createdAt: "asc" } });
    return rows.map((row) => row.id);
  }

  // Evidence from this agent since the last send-back: what the visit in progress has.
  private currentAttempt(task: FieldTask, agentUserId: string) {
    return { fieldTaskId: task.id, deletedAt: null, uploadedByUserId: agentUserId, uploadedAt: { gte: task.returnedAt ?? new Date(0) } };
  }

  private async agentTask(agent: { userId: string; vendorId: string }, taskId: string): Promise<FieldTask> {
    const task = await this.prisma.fieldTask.findFirst({ where: { id: taskId, vendorId: agent.vendorId, assignedToUserId: agent.userId } });
    if (!task) throw new NotFoundException("Task not found");
    if (task.status !== "ACCEPTED" && task.status !== "IN_PROGRESS") throw new BadRequestException("Evidence can be added only while the visit is open");
    return task;
  }

  // Keystone sees every task's evidence, a vendor admin their vendor's, an agent their own task's.
  private async viewableTask(viewer: EvidenceViewer, taskId: string): Promise<FieldTask> {
    const task = await this.prisma.fieldTask.findFirst({
      where: { id: taskId, ...(viewer.vendorId ? { vendorId: viewer.vendorId, ...(viewer.manager ? {} : { assignedToUserId: viewer.userId }) } : {}) }
    });
    if (!task) throw new NotFoundException("Task not found");
    return task;
  }

  private toEvidence(row: FieldEvidence, task: FieldTask) {
    return {
      id: row.id,
      kind: row.kind,
      content_type: row.contentType,
      size_bytes: row.sizeBytes,
      captured_at: row.capturedAt?.toISOString() ?? null,
      location: row.capturedLatitude != null && row.capturedLongitude != null ? { latitude: row.capturedLatitude, longitude: row.capturedLongitude } : null,
      uploaded_at: row.uploadedAt?.toISOString() ?? null,
      uploaded_by: row.uploadedByUserId,
      // Part of the visit in progress (or the last one submitted), not an earlier attempt.
      current: row.uploadedByUserId === task.assignedToUserId && (!task.returnedAt || (row.uploadedAt ?? row.createdAt) >= task.returnedAt),
      file_url: `/v1/admin/field-tasks/${task.id}/evidence/${row.id}/file`
    };
  }
}

function coordinate(value: unknown, label: string, bound: number): number | null {
  if (value === undefined || value === null || value === "") return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || Math.abs(numeric) > bound) throw new BadRequestException(`${label} is out of range`);
  return numeric;
}

function safeFileName(value: string): string {
  return (String(value || "").split(/[\\/]/).pop() || "").normalize("NFKC").replace(/[\u0000-\u001f\u007f"]/g, "").trim().slice(0, 180);
}
