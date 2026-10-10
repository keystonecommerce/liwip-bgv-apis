import { Controller, Get, Inject, Query, UseGuards } from "@nestjs/common";
import { ApiKeyGuard } from "../../common/auth/api-key.guard";
import { ScopeGuard } from "../../common/auth/scope.guard";
import { RequireScopes } from "../../common/auth/scopes";
import { ClientContext, CurrentClient } from "../../common/auth/client-context";
import { parseUsageDate, UsageService } from "./usage.service";
@Controller("v1/usage")
@UseGuards(ApiKeyGuard, ScopeGuard)
export class UsageController {
  constructor(@Inject(UsageService) private readonly usage: UsageService) {}
  @Get()
  @RequireScopes("usage:read")
  report(@CurrentClient() client: ClientContext, @Query("from") from?: string, @Query("to") to?: string) {
    return this.usage.getPartnerUsage(client, { from: parseUsageDate(from), to: parseUsageDate(to) });
  }
}
