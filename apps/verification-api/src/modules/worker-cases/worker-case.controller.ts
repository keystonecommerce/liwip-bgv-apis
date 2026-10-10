import { BadRequestException, Body, Controller, Get, HttpCode, Inject, Param, Post, Put, UploadedFile, UseGuards, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { ApiKeyGuard } from "../../common/auth/api-key.guard";
import { ClientContext, CurrentClient } from "../../common/auth/client-context";
import { ScopeGuard } from "../../common/auth/scope.guard";
import { RequireScopes } from "../../common/auth/scopes";
import { CurrentWorker, WorkerGuard } from "../../common/auth/worker.guard";
import type { WorkerIdentity } from "../../common/auth/worker-token";
import { LimitName, RateLimitService } from "../../common/security/rate-limit.service";
import { isWorkerCheckKind } from "./worker-case.inputs";
import { DetailsInput, SelfieUpload, WorkerCaseService } from "./worker-case.service";

/**
 * A worker's own case. Needs the platform API key and the worker token from OTP
 * verify; the phone always comes from the token, never from the request.
 */
@Controller("v1/worker/case")
@UseGuards(ApiKeyGuard, ScopeGuard, WorkerGuard)
@RequireScopes("worker:cases")
export class WorkerCaseController {
  constructor(
    @Inject(WorkerCaseService) private readonly cases: WorkerCaseService,
    @Inject(RateLimitService) private readonly limits: RateLimitService
  ) {}

  /** Limits are per worker: the platform's own server relays every worker. */
  private async limit(worker: WorkerIdentity, ...names: LimitName[]) {
    for (const name of names) await this.limits.consume(name, `${worker.tenantId}:${worker.clientId}:${worker.phone}`);
  }

  @Get()
  open(@CurrentWorker() worker: WorkerIdentity, @CurrentClient() client: ClientContext) {
    return this.cases.open(worker, client);
  }

  @Put("name")
  async saveName(@Body() body: { fullName?: string }, @CurrentWorker() worker: WorkerIdentity, @CurrentClient() client: ClientContext) {
    await this.limit(worker, "caseEditsPerWorker");
    return this.cases.saveName(worker, client, body?.fullName);
  }

  @Put("checks")
  async selectChecks(@Body() body: { checks?: string[] }, @CurrentWorker() worker: WorkerIdentity, @CurrentClient() client: ClientContext) {
    await this.limit(worker, "caseEditsPerWorker");
    return this.cases.selectChecks(worker, client, body);
  }

  @Put("details")
  async saveDetails(@Body() body: DetailsInput, @CurrentWorker() worker: WorkerIdentity, @CurrentClient() client: ClientContext) {
    await this.limit(worker, "caseEditsPerWorker");
    return this.cases.saveDetails(worker, client, body || {});
  }

  @Post("consent")
  @HttpCode(200)
  async consent(@Body() body: { textVersion?: string; items?: string[] }, @CurrentWorker() worker: WorkerIdentity, @CurrentClient() client: ClientContext) {
    await this.limit(worker, "caseEditsPerWorker");
    return this.cases.consent(worker, client, body);
  }

  @Post("identity/aadhaar/start")
  @HttpCode(200)
  async startAadhaar(@CurrentWorker() worker: WorkerIdentity, @CurrentClient() client: ClientContext) {
    await this.limit(worker, "aadhaarPerWorker");
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
  async submitCheck(
    @Param("kind") kind: string,
    @Body() body: Record<string, unknown>,
    @UploadedFile() selfie: SelfieUpload | undefined,
    @CurrentWorker() worker: WorkerIdentity,
    @CurrentClient() client: ClientContext
  ) {
    const normalised = String(kind || "").toUpperCase().replace(/-/g, "_");
    if (!isWorkerCheckKind(normalised)) throw new BadRequestException("Unknown check");
    // Each submission is a paid provider call.
    await this.limit(worker, "checkPerWorkerHour", "checkPerWorkerDay");
    return this.cases.submitCheck(worker, client, normalised, body || {}, selfie);
  }
}
