import { Body, Controller, Get, Headers, Inject, Param, Post, UploadedFiles, UseGuards, UseInterceptors } from "@nestjs/common";
import { FileFieldsInterceptor } from "@nestjs/platform-express";
import { ApiKeyGuard } from "../../common/auth/api-key.guard";
import { ClientContext, CurrentClient } from "../../common/auth/client-context";
import { ScopeGuard } from "../../common/auth/scope.guard";
import { RequireScopes } from "../../common/auth/scopes";
import { CheckFile, CheckFiles } from "../../domain/supplementary-checks";
import { SupplementaryCheckService } from "./supplementary-check.service";

@Controller("v1")
@UseGuards(ApiKeyGuard, ScopeGuard)
export class SupplementaryCheckController {
  constructor(@Inject(SupplementaryCheckService) private readonly service: SupplementaryCheckService) {}

  @Get("verification-checks")
  @RequireScopes("applications:read")
  list() { return this.service.list(); }

  @Post("applications/:applicationId/checks/:type")
  @RequireScopes("verifications:write")
  @UseInterceptors(FileFieldsInterceptor([
    { name: "file", maxCount: 1 }, { name: "front", maxCount: 1 }, { name: "back", maxCount: 1 }
  ], { limits: { fileSize: 5 * 1024 * 1024, files: 2, fields: 16, fieldSize: 4096 } }))
  execute(
    @Param("applicationId") applicationId: string,
    @Param("type") type: string,
    @Headers("idempotency-key") requestKey: string,
    @Body() input: Record<string, unknown>,
    @UploadedFiles() uploads: Partial<Record<keyof CheckFiles, CheckFile[]>> | undefined,
    @CurrentClient() client: ClientContext
  ) {
    const files: CheckFiles = {};
    for (const field of ["file", "front", "back"] as const) if (uploads?.[field]?.[0]) files[field] = uploads[field]![0];
    return this.service.execute(applicationId, type, input, files, requestKey, { tenantId: client.tenantId, clientId: client.clientId });
  }
}
