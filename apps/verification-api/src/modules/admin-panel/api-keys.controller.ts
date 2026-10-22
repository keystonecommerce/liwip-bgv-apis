import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, UseGuards } from "@nestjs/common";
import { AdminAccessGuard } from "../admin-access/admin-access.guard";
import { AdminContext, AuditAction, CurrentAdmin, RecentSignIn, RequirePermission } from "../admin-access/admin-context";
import { ApiKeyInput, ApiKeysService } from "./api-keys.service";

/**
 * Partner API keys (apikeys.manage). Keystone works across every partner or picks one with
 * x-partner-id; a partner admin sees only their own programs' keys.
 */
@Controller("v1/admin/api-keys")
@UseGuards(AdminAccessGuard)
export class ApiKeysController {
  constructor(@Inject(ApiKeysService) private readonly keys: ApiKeysService) {}

  @Get()
  @RequirePermission("apikeys.manage", { allPartners: true })
  @AuditAction("apikeys.list")
  list(@CurrentAdmin() admin: AdminContext, @Query("programId") programId?: string) {
    return this.keys.list(admin, programId || undefined);
  }

  /** The scopes this caller may grant, with plain labels for the key form. */
  @Get("scopes")
  @RequirePermission("apikeys.manage", { allPartners: true })
  @AuditAction("apikeys.scopes")
  scopes(@CurrentAdmin() admin: AdminContext) {
    return this.keys.scopes(admin);
  }

  @Post()
  @RequirePermission("apikeys.manage", { allPartners: true })
  @RecentSignIn()
  @AuditAction("apikeys.create", { resourceType: "ApiKey" })
  create(@CurrentAdmin() admin: AdminContext, @Body() body: ApiKeyInput) {
    return this.keys.create(admin, body ?? {});
  }

  @Post(":keyId/rotate")
  @HttpCode(200)
  @RequirePermission("apikeys.manage", { allPartners: true })
  @RecentSignIn()
  @AuditAction("apikeys.rotate", { resourceType: "ApiKey", resourceParam: "keyId" })
  rotate(@CurrentAdmin() admin: AdminContext, @Param("keyId") keyId: string) {
    return this.keys.rotate(admin, keyId);
  }

  @Post(":keyId/revoke")
  @HttpCode(200)
  @RequirePermission("apikeys.manage", { allPartners: true })
  @RecentSignIn()
  @AuditAction("apikeys.revoke", { resourceType: "ApiKey", resourceParam: "keyId" })
  revoke(@CurrentAdmin() admin: AdminContext, @Param("keyId") keyId: string) {
    return this.keys.revoke(admin, keyId);
  }
}
