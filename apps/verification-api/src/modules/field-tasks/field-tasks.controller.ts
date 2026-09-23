import { Body, Controller, Get, Inject, Param, Post, UseGuards } from "@nestjs/common";
import type { PortalUserContext } from "../portal-auth/portal-auth.service";
import { CurrentPortalUser, PortalAuthGuard, PortalRoles } from "../portal-auth/portal-context";
import { FieldTasksService } from "./field-tasks.service";

@Controller("v1/field/tasks")
@UseGuards(PortalAuthGuard)
@PortalRoles("FIELD_AGENT")
export class FieldTasksController {
  constructor(@Inject(FieldTasksService) private readonly service: FieldTasksService) {}

  @Get()
  list(@CurrentPortalUser() agent: PortalUserContext) {
    return this.service.listForAgent(agent);
  }

  @Get(":id")
  get(@Param("id") id: string, @CurrentPortalUser() agent: PortalUserContext) {
    return this.service.getForAgent(agent, id);
  }

  @Post(":id/accept")
  accept(@Param("id") id: string, @CurrentPortalUser() agent: PortalUserContext) {
    return this.service.accept(agent, id);
  }

  @Post(":id/reject")
  reject(
    @Param("id") id: string,
    @Body() body: { reason?: string },
    @CurrentPortalUser() agent: PortalUserContext
  ) {
    return this.service.reject(agent, id, body?.reason || "");
  }

  @Post(":id/arrive")
  arrive(
    @Param("id") id: string,
    @Body() body: { latitude?: number; longitude?: number },
    @CurrentPortalUser() agent: PortalUserContext
  ) {
    return this.service.arrive(agent, id, body || {});
  }

  @Post(":id/submit")
  submit(
    @Param("id") id: string,
    @Body() body: { outcome?: string; notes?: string },
    @CurrentPortalUser() agent: PortalUserContext
  ) {
    return this.service.submit(agent, id, body || {});
  }
}
