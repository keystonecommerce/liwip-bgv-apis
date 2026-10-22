import { Body, Controller, ForbiddenException, Get, HttpCode, Inject, Param, Post, Query, UseGuards } from "@nestjs/common";
import { AdminAccessGuard } from "../admin-access/admin-access.guard";
import { AdminContext, AuditAction, CurrentAdmin, RequirePermission } from "../admin-access/admin-context";
import { id } from "../admin-panel/input";
import { FieldAgent, FieldTasksService } from "./field-tasks.service";

/** The vendor the request acts for (field.tasks.* are VENDOR permissions). */
function vendorOf(admin: AdminContext): string | null {
  if (admin.scope.kind === "VENDOR") return admin.scope.vendorId;
  if (admin.scope.kind === "ALL_VENDORS") return null;
  throw new ForbiddenException("No vendor on this request");
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
  constructor(@Inject(FieldTasksService) private readonly service: FieldTasksService) {}

  @Get()
  @RequirePermission("field.tasks.read", { allVendors: true })
  @AuditAction("field.tasks.list")
  list(@CurrentAdmin() admin: AdminContext, @Query("status") status?: string, @Query("unassigned") unassigned?: string) {
    return this.service.listForManager(vendorOf(admin), { status: status ? String(status).toUpperCase() : undefined, unassigned: unassigned === "true" });
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

  @Post(":id/submit")
  @HttpCode(200)
  @RequirePermission("field.tasks.perform")
  @AuditAction("field.tasks.submit", { resourceType: "FieldTask", resourceParam: "id" })
  submit(@CurrentAdmin() admin: AdminContext, @Param("id") taskId: string, @Body() body: { outcome?: string; notes?: string }) {
    return this.service.submit(agentOf(admin), id(taskId, "id"), body || {});
  }
}
