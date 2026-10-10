import { Body, Controller, Get, Inject, Param, Post, UseGuards } from "@nestjs/common";
import { ApiKeyGuard } from "../../common/auth/api-key.guard";
import { ClientContext, CurrentClient } from "../../common/auth/client-context";
import { ScopeGuard } from "../../common/auth/scope.guard";
import { RequireScopes } from "../../common/auth/scopes";
import { ApplicationSchema } from "../../domain/verification.types";
import { VerificationService } from "../verifications/verification.service";

@Controller("v1")
@UseGuards(ApiKeyGuard, ScopeGuard)
export class PlatformController {
  constructor(@Inject(VerificationService) private readonly verificationService: VerificationService) {}

  @Get("packages")
  @RequireScopes("packages:read")
  listPackages() {
    return this.verificationService.listPackages();
  }

  @Post("applications")
  @RequireScopes("applications:write")
  createApplication(@Body() payload: ApplicationSchema, @CurrentClient() client: ClientContext) {
    return this.verificationService.createApplication(
      payload,
      undefined,
      { tenantId: client.tenantId, clientId: client.clientId, apiKeyId: client.apiKeyId }
    );
  }

  @Get("applications/:id/verifications")
  @RequireScopes("applications:read")
  getApplication(@Param("id") id: string, @CurrentClient() client: ClientContext) {
    return this.verificationService.getApplicationDetails(id, { tenantId: client.tenantId, clientId: client.clientId, apiKeyId: client.apiKeyId });
  }

  @Post("verifications/:id/retry")
  @RequireScopes("verifications:retry")
  retryVerification(@Param("id") id: string, @CurrentClient() client: ClientContext) {
    return this.verificationService.retryVerification(id, { tenantId: client.tenantId, clientId: client.clientId, apiKeyId: client.apiKeyId });
  }

  @Post("verifications/:id/decision")
  @RequireScopes("verifications:review")
  decideVerification(
    @Param("id") id: string,
    @Body() payload: { decision?: string; note?: string },
    @CurrentClient() client: ClientContext
  ) {
    return this.verificationService.reviewVerification(
      id,
      payload,
      { tenantId: client.tenantId, clientId: client.clientId, apiKeyId: client.apiKeyId }
    );
  }
}

