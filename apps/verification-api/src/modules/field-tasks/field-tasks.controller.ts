import { Body, Controller, Delete, ForbiddenException, Get, HttpCode, Inject, Param, Post, Query, Res, UploadedFile, UseGuards, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import type { Response } from "express";
import { AdminAccessGuard } from "../admin-access/admin-access.guard";
import { AdminContext, AuditAction, CurrentAdmin, RequirePermission } from "../admin-access/admin-context";
import { id, optionalDate } from "../admin-panel/input";
import { EvidenceUpload, EvidenceViewer, FieldEvidenceService, MAX_EVIDENCE_BYTES } from "./field-evidence.service";
import { FieldAgent, FieldTasksService } from "./field-tasks.service";

/** The vendor the request acts for (field.tasks.* are VENDOR permissions). */
function vendorOf(admin: AdminContext): string | null {
  if (admin.scope.kind === "VENDOR") return admin.scope.vendorId;
  if (admin.scope.kind === "ALL_VENDORS") return null;
  throw new ForbiddenException("No vendor on this request");
}

/** undefined keeps the current value, null or "" clears it. */
function nullableId(value: unknown, label: string): string | null | undefined {
  if (value === undefined) return undefined;
  return value === null || value === "" ? null : id(value, label);
}

function viewerOf(admin: AdminContext): EvidenceViewer {
  return { vendorId: vendorOf(admin), userId: admin.user.id, manager: admin.permissions.has("field.tasks.manage") };
}

function agentOf(admin: AdminContext): FieldAgent {
  const vendorId = vendorOf(admin);
  if (!vendorId) throw new ForbiddenException("Choose the vendor you are working for (x-vendor-id)");
  return { userId: admin.user.id, vendorId };
}

/**
 * Field tasks, on staff sessions like every other admin route. Keystone (every vendor) lists
 * tasks and hands each to a vendor; vendor admins see their vendor's tasks; field agents work
 * their vendor's pool. A field agent working for one vendor needs no x-vendor-id.
 */
@Controller("v1/admin/field-tasks")
@UseGuards(AdminAccessGuard)
export class FieldTasksController {
  constructor(
    @Inject(FieldTasksService) private readonly service: FieldTasksService,
    @Inject(FieldEvidenceService) private readonly evidence: FieldEvidenceService
  ) {}

  @Get()
  @RequirePermission("field.tasks.read", { allVendors: true })
  @AuditAction("field.tasks.list")
  list(@CurrentAdmin() admin: AdminContext, @Query("status") status?: string, @Query("unassigned") unassigned?: string, @Query("view") view?: string) {
    return this.service.listForManager(vendorOf(admin), { status: status ? String(status).toUpperCase() : undefined, unassigned: unassigned === "true", view: view ? String(view) : undefined });
  }

  /**
   * Who does this visit and by when. Keystone: { vendorId?, agentId?, dueAt? }. A vendor admin:
   * { agentId } for one of their own agents. Omitted fields stay as they are; null clears.
   */
  @Post(":id/assign")
  @HttpCode(200)
  @RequirePermission("field.tasks.manage", { allVendors: true })
  @AuditAction("field.tasks.assign", { resourceType: "FieldTask", resourceParam: "id" })
  assign(@CurrentAdmin() admin: AdminContext, @Param("id") taskId: string, @Body() body: { vendorId?: unknown; agentId?: unknown; dueAt?: unknown }) {
    const input = { vendorId: nullableId(body?.vendorId, "vendorId"), agentId: nullableId(body?.agentId, "agentId"), dueAt: optionalDate(body?.dueAt, "dueAt") };
    admin.audit = { ...admin.audit, metadata: { vendorId: input.vendorId, agentId: input.agentId, dueAt: input.dueAt === undefined ? undefined : input.dueAt?.toISOString() ?? null } };
    return this.service.assign(vendorOf(admin), id(taskId, "id"), input);
  }

  /** Keystone only: the visit is no longer needed. The check stays in review. */
  @Post(":id/cancel")
  @HttpCode(200)
  @RequirePermission("field.tasks.manage", { allVendors: true })
  @AuditAction("field.tasks.cancel", { resourceType: "FieldTask", resourceParam: "id" })
  cancel(@CurrentAdmin() admin: AdminContext, @Param("id") taskId: string, @Body() body: { reason?: string }) {
    if (admin.scope.kind !== "ALL_VENDORS") throw new ForbiddenException("Only Keystone cancels visits");
    admin.audit = { ...admin.audit, metadata: { reason: body?.reason } };
    return this.service.cancel(id(taskId, "id"), body?.reason);
  }

  /** Keystone only: which vendor does this visit. { vendorId: null } takes it back. */
  @Post(":id/vendor")
  @HttpCode(200)
  @RequirePermission("field.tasks.manage", { allVendors: true })
  @AuditAction("field.tasks.assign_vendor", { resourceType: "FieldTask", resourceParam: "id" })
  assignVendor(@CurrentAdmin() admin: AdminContext, @Param("id") taskId: string, @Body() body: { vendorId?: string | null }) {
    if (admin.scope.kind !== "ALL_VENDORS") throw new ForbiddenException("Only Keystone hands tasks to vendors");
    return this.service.assignVendor(id(taskId, "id"), body?.vendorId ? id(body.vendorId, "vendorId") : null);
  }

  /** Keystone only: send a submitted visit back for another one, saying what to check again. */
  @Post(":id/send-back")
  @HttpCode(200)
  @RequirePermission("field.tasks.manage", { allVendors: true })
  @AuditAction("field.tasks.send_back", { resourceType: "FieldTask", resourceParam: "id" })
  sendBack(@CurrentAdmin() admin: AdminContext, @Param("id") taskId: string, @Body() body: { note?: string }) {
    if (admin.scope.kind !== "ALL_VENDORS") throw new ForbiddenException("Only Keystone sends visits back");
    return this.service.sendBack(id(taskId, "id"), body?.note);
  }

  /** A field agent's own tasks and their vendor's open pool. */
  @Get("mine")
  @RequirePermission("field.tasks.perform")
  @AuditAction("field.tasks.mine")
  mine(@CurrentAdmin() admin: AdminContext) {
    return this.service.listForAgent(agentOf(admin));
  }

  @Get(":id")
  @RequirePermission("field.tasks.perform")
  @AuditAction("field.tasks.read", { resourceType: "FieldTask", resourceParam: "id" })
  get(@CurrentAdmin() admin: AdminContext, @Param("id") taskId: string) {
    return this.service.getForAgent(agentOf(admin), id(taskId, "id"));
  }

  @Post(":id/accept")
  @HttpCode(200)
  @RequirePermission("field.tasks.perform")
  @AuditAction("field.tasks.accept", { resourceType: "FieldTask", resourceParam: "id" })
  accept(@CurrentAdmin() admin: AdminContext, @Param("id") taskId: string) {
    return this.service.accept(agentOf(admin), id(taskId, "id"));
  }

  @Post(":id/reject")
  @HttpCode(200)
  @RequirePermission("field.tasks.perform")
  @AuditAction("field.tasks.reject", { resourceType: "FieldTask", resourceParam: "id" })
  reject(@CurrentAdmin() admin: AdminContext, @Param("id") taskId: string, @Body() body: { reason?: string }) {
    return this.service.reject(agentOf(admin), id(taskId, "id"), body?.reason || "");
  }

  @Post(":id/arrive")
  @HttpCode(200)
  @RequirePermission("field.tasks.perform")
  @AuditAction("field.tasks.arrive", { resourceType: "FieldTask", resourceParam: "id" })
  arrive(@CurrentAdmin() admin: AdminContext, @Param("id") taskId: string, @Body() body: { latitude?: number; longitude?: number }) {
    return this.service.arrive(agentOf(admin), id(taskId, "id"), body || {});
  }

  /** A photo (with latitude and longitude) or a signature, as multipart `file` plus `kind`. */
  @Post(":id/evidence")
  @HttpCode(201)
  @RequirePermission("field.tasks.perform")
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: MAX_EVIDENCE_BYTES, files: 1 } }))
  @AuditAction("field.tasks.evidence.add", { resourceType: "FieldTask", resourceParam: "id" })
  addEvidence(@CurrentAdmin() admin: AdminContext, @Param("id") taskId: string, @Body() body: Record<string, unknown>, @UploadedFile() file: EvidenceUpload | undefined) {
    return this.evidence.upload(agentOf(admin), id(taskId, "id"), body || {}, file);
  }

  @Delete(":id/evidence/:evidenceId")
  @RequirePermission("field.tasks.perform")
  @AuditAction("field.tasks.evidence.remove", { resourceType: "FieldTask", resourceParam: "id" })
  removeEvidence(@CurrentAdmin() admin: AdminContext, @Param("id") taskId: string, @Param("evidenceId") evidenceId: string) {
    return this.evidence.remove(agentOf(admin), id(taskId, "id"), id(evidenceId, "evidenceId"));
  }

  /** Keystone, the vendor's admin, or the task's agent. */
  @Get(":id/evidence")
  @RequirePermission("field.tasks.read", { allVendors: true })
  @AuditAction("field.tasks.evidence.list", { resourceType: "FieldTask", resourceParam: "id" })
  listEvidence(@CurrentAdmin() admin: AdminContext, @Param("id") taskId: string) {
    return this.evidence.list(viewerOf(admin), id(taskId, "id"));
  }

  @Get(":id/evidence/:evidenceId/file")
  @RequirePermission("field.tasks.read", { allVendors: true })
  @AuditAction("field.tasks.evidence.read", { resourceType: "FieldTask", resourceParam: "id" })
  async evidenceFile(@CurrentAdmin() admin: AdminContext, @Param("id") taskId: string, @Param("evidenceId") evidenceId: string, @Res() res: Response) {
    const file = await this.evidence.file(viewerOf(admin), id(taskId, "id"), id(evidenceId, "evidenceId"));
    res.setHeader("Content-Type", file.contentType);
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.send(file.bytes);
  }

  @Post(":id/submit")
  @HttpCode(200)
  @RequirePermission("field.tasks.perform")
  @AuditAction("field.tasks.submit", { resourceType: "FieldTask", resourceParam: "id" })
  submit(@CurrentAdmin() admin: AdminContext, @Param("id") taskId: string, @Body() body: { outcome?: string; notes?: string }) {
    return this.service.submit(agentOf(admin), id(taskId, "id"), body || {});
  }
}
