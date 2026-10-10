import { BadRequestException, Body, Controller, Get, HttpCode, Inject, Param, Post, Put, UploadedFile, UseGuards, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { ApiKeyGuard } from "../../common/auth/api-key.guard";
import { ClientContext, CurrentClient } from "../../common/auth/client-context";
import { ScopeGuard } from "../../common/auth/scope.guard";
import { RequireScopes } from "../../common/auth/scopes";
import { CurrentWorker, WorkerGuard } from "../../common/auth/worker.guard";
import type { WorkerIdentity } from "../../common/auth/worker-token";
import { isWorkerCheckKind } from "./worker-case.inputs";
import { SelfieUpload, WorkerCaseService } from "./worker-case.service";

/**
 * A worker's own case. Needs the platform API key and the worker token from OTP
 * verify; the phone always comes from the token, never from the request.
 */
@Controller("v1/worker/case")
@UseGuards(ApiKeyGuard, ScopeGuard, WorkerGuard)
@RequireScopes("worker:cases")
export class WorkerCaseController {
  constructor(@Inject(WorkerCaseService) private readonly cases: WorkerCaseService) {}

  @Get()
  open(@CurrentWorker() worker: WorkerIdentity, @CurrentClient() client: ClientContext) {
    return this.cases.open(worker, client);
  }

  @Put("package")
  choosePackage(@Body() body: { packageCode?: string }, @CurrentWorker() worker: WorkerIdentity, @CurrentClient() client: ClientContext) {
    return this.cases.choosePackage(worker, client, String(body?.packageCode || ""));
  }

  @Post("consent")
  @HttpCode(200)
  consent(@Body() body: { textVersion?: string; items?: string[] }, @CurrentWorker() worker: WorkerIdentity, @CurrentClient() client: ClientContext) {
    return this.cases.consent(worker, client, body);
  }

  @Post("identity/aadhaar/start")
  @HttpCode(200)
  startAadhaar(@CurrentWorker() worker: WorkerIdentity, @CurrentClient() client: ClientContext) {
    return this.cases.startAadhaar(worker, client);
  }

  @Post("identity/aadhaar/complete")
  @HttpCode(200)
  completeAadhaar(@CurrentWorker() worker: WorkerIdentity, @CurrentClient() client: ClientContext) {
    return this.cases.completeAadhaar(worker, client);
  }

  @Post("checks/:kind")
  @HttpCode(200)
  @UseInterceptors(FileInterceptor("selfie", { limits: { fileSize: 5 * 1024 * 1024, files: 1 } }))
  submitCheck(
    @Param("kind") kind: string,
    @Body() body: Record<string, unknown>,
    @UploadedFile() selfie: SelfieUpload | undefined,
    @CurrentWorker() worker: WorkerIdentity,
    @CurrentClient() client: ClientContext
  ) {
    const normalised = String(kind || "").toUpperCase().replace(/-/g, "_");
    if (!isWorkerCheckKind(normalised)) throw new BadRequestException("Unknown check");
    return this.cases.submitCheck(worker, client, normalised, body || {}, selfie);
  }
}
