import { Body, Controller, Get, HttpCode, Inject, Param, Post, UseGuards } from "@nestjs/common";
import { AdminAccessGuard } from "../admin-access/admin-access.guard";
import { AdminContext, AuditAction, CurrentAdmin, RecentSignIn, RequirePermission } from "../admin-access/admin-context";
import { id } from "../admin-panel/input";
import { EndpointInput, WebhooksService } from "./webhooks.service";

/** Webhook endpoints (webhooks.manage). Keystone works across partners; a partner admin on their own. */
@Controller("v1/admin/webhooks")
@UseGuards(AdminAccessGuard)
export class WebhooksController {
  constructor(@Inject(WebhooksService) private readonly webhooks: WebhooksService) {}

  @Get()
  @RequirePermission("webhooks.manage", { allPartners: true })
  @AuditAction("webhooks.list")
  list(@CurrentAdmin() admin: AdminContext) {
    return this.webhooks.list(admin);
  }

  @Post()
  @RequirePermission("webhooks.manage", { allPartners: true })
  @RecentSignIn()
  @AuditAction("webhooks.create", { resourceType: "WebhookEndpoint" })
  create(@CurrentAdmin() admin: AdminContext, @Body() body: EndpointInput) {
    return this.webhooks.create(admin, body ?? {});
  }

  @Post(":endpointId/rotate-secret")
  @HttpCode(200)
  @RequirePermission("webhooks.manage", { allPartners: true })
  @RecentSignIn()
  @AuditAction("webhooks.rotate", { resourceType: "WebhookEndpoint", resourceParam: "endpointId" })
  rotate(@CurrentAdmin() admin: AdminContext, @Param("endpointId") endpointId: string) {
    return this.webhooks.rotate(admin, id(endpointId, "endpointId"));
  }

  @Post(":endpointId/disable")
  @HttpCode(200)
  @RequirePermission("webhooks.manage", { allPartners: true })
  @AuditAction("webhooks.disable", { resourceType: "WebhookEndpoint", resourceParam: "endpointId" })
  disable(@CurrentAdmin() admin: AdminContext, @Param("endpointId") endpointId: string) {
    return this.webhooks.setStatus(admin, id(endpointId, "endpointId"), "DISABLED");
  }

  @Post(":endpointId/enable")
  @HttpCode(200)
  @RequirePermission("webhooks.manage", { allPartners: true })
  @AuditAction("webhooks.enable", { resourceType: "WebhookEndpoint", resourceParam: "endpointId" })
  enable(@CurrentAdmin() admin: AdminContext, @Param("endpointId") endpointId: string) {
    return this.webhooks.setStatus(admin, id(endpointId, "endpointId"), "ACTIVE");
  }

  @Post(":endpointId/test")
  @HttpCode(201)
  @RequirePermission("webhooks.manage", { allPartners: true })
  @AuditAction("webhooks.test", { resourceType: "WebhookEndpoint", resourceParam: "endpointId" })
  test(@CurrentAdmin() admin: AdminContext, @Param("endpointId") endpointId: string) {
    return this.webhooks.test(admin, id(endpointId, "endpointId"));
  }

  @Get(":endpointId/deliveries")
  @RequirePermission("webhooks.manage", { allPartners: true })
  @AuditAction("webhooks.deliveries", { resourceType: "WebhookEndpoint", resourceParam: "endpointId" })
  deliveries(@CurrentAdmin() admin: AdminContext, @Param("endpointId") endpointId: string) {
    return this.webhooks.deliveries(admin, id(endpointId, "endpointId"));
  }

  @Post("deliveries/:deliveryId/retry")
  @HttpCode(200)
  @RequirePermission("webhooks.manage", { allPartners: true })
  @AuditAction("webhooks.retry", { resourceType: "WebhookDelivery", resourceParam: "deliveryId" })
  retry(@CurrentAdmin() admin: AdminContext, @Param("deliveryId") deliveryId: string) {
    return this.webhooks.retry(admin, id(deliveryId, "deliveryId"));
  }
}
