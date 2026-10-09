import { Body, Controller, Get, Inject, Post, Query, UseGuards } from "@nestjs/common";
import { ApiKeyGuard } from "../../common/auth/api-key.guard";
import { ClientContext, CurrentClient } from "../../common/auth/client-context";
import { ScopeGuard } from "../../common/auth/scope.guard";
import { RequireScopes } from "../../common/auth/scopes";
import type { AadhaarOvseInitializeData } from "../../integrations/aadhaar-session.types";
import { AadhaarOvseService } from "./aadhaar-ovse.service";

@Controller("v1/aadhaar/ovse")
@UseGuards(ApiKeyGuard, ScopeGuard)
export class AadhaarOvseController {
  constructor(@Inject(AadhaarOvseService) private readonly ovse: AadhaarOvseService) {}

  @Post("initialize")
  @RequireScopes("aadhaar:write")
  initialize(
    @Body() payload: Partial<AadhaarOvseInitializeData>,
    @CurrentClient() client: ClientContext
  ) {
    return this.ovse.initialize(payload, client);
  }

  @Get("status")
  @RequireScopes("aadhaar:read")
  status(@Query("client_id") clientId: string, @CurrentClient() client: ClientContext) {
    return this.ovse.status(clientId, client);
  }

  @Get("result")
  @RequireScopes("aadhaar:read")
  result(@Query("client_id") clientId: string, @CurrentClient() client: ClientContext) {
    return this.ovse.result(clientId, client);
  }
}
