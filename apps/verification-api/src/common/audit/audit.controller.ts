import { Controller, Get, Inject, Query, UseGuards } from "@nestjs/common";
import { ApiKeyGuard } from "../auth/api-key.guard";
import { ClientContext, CurrentClient } from "../auth/client-context";
import { ScopeGuard } from "../auth/scope.guard";
import { RequireScopes } from "../auth/scopes";
import { AuditService } from "./audit.service";

/**
 * Lets a partner read their OWN activity history. Always scoped to the caller's
 * tenant + client (derived from the API key), so a partner can never read
 * another partner's audit trail.
 */
@Controller("v1/audit-logs")
@UseGuards(ApiKeyGuard, ScopeGuard)
export class AuditController {
  constructor(@Inject(AuditService) private readonly audit: AuditService) {}

  @Get()
  @RequireScopes("audit:read")
  async list(@CurrentClient() client: ClientContext, @Query("limit") limit?: string) {
    const rows = await this.audit.list({
      tenantId: client.tenantId,
      clientId: client.clientId,
      limit: limit ? Number(limit) : undefined,
    });
    return { logs: rows };
  }
}
