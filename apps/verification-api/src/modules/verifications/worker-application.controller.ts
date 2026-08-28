import { Body, Controller, Inject, Post, UploadedFiles, UseGuards, UseInterceptors } from "@nestjs/common";
import { FileFieldsInterceptor } from "@nestjs/platform-express";
import { ApiKeyGuard } from "../../common/auth/api-key.guard";
import { ClientContext, CurrentClient } from "../../common/auth/client-context";
import { ScopeGuard } from "../../common/auth/scope.guard";
import { RequireScopes } from "../../common/auth/scopes";
import { VerificationService } from "./verification.service";
import { buildWorkerApplication, WorkerUploadFile, WorkerVerificationPayload } from "./worker-application";

@Controller("v1/worker-verifications")
@UseGuards(ApiKeyGuard, ScopeGuard)
export class WorkerApplicationController {
  constructor(@Inject(VerificationService) private readonly verificationService: VerificationService) {}

  @Post()
  @RequireScopes("applications:write")
  @UseInterceptors(FileFieldsInterceptor([
    { name: "aadhaar_file", maxCount: 1 },
    { name: "selfie", maxCount: 1 },
    { name: "id_card", maxCount: 1 }
  ], { limits: { fileSize: 10 * 1024 * 1024 } }))
  create(
    @UploadedFiles() files: Record<string, WorkerUploadFile[]> | undefined,
    @Body() payload: WorkerVerificationPayload,
    @CurrentClient() client: ClientContext
  ) {
    const request = buildWorkerApplication(payload, files);
    return this.verificationService.createApplication(
      request.data,
      request.sensitiveInputs,
      { tenantId: client.tenantId, clientId: client.clientId }
    );
  }
}
