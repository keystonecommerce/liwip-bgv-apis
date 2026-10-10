import { Controller, Get, HttpCode, Inject, Post, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { ApiKeyGuard } from "../../common/auth/api-key.guard";
import { ClientContext, CurrentClient } from "../../common/auth/client-context";
import { ScopeGuard } from "../../common/auth/scope.guard";
import { RequireScopes } from "../../common/auth/scopes";
import { CurrentWorker, WorkerGuard } from "../../common/auth/worker.guard";
import type { WorkerIdentity } from "../../common/auth/worker-token";
import { RateLimitService } from "../../common/security/rate-limit.service";
import { CardService } from "./card.service";

/** The worker's own card. Same protection as their case: platform key plus worker token. */
@Controller("v1/worker/card")
@UseGuards(ApiKeyGuard, ScopeGuard, WorkerGuard)
@RequireScopes("worker:cases")
export class CardController {
  constructor(
    @Inject(CardService) private readonly cards: CardService,
    @Inject(RateLimitService) private readonly limits: RateLimitService
  ) {}

  @Get()
  card(@CurrentWorker() worker: WorkerIdentity, @CurrentClient() client: ClientContext) {
    return this.cards.forWorker(worker, client);
  }

  @Get("live-code")
  liveCode(@CurrentWorker() worker: WorkerIdentity) {
    return this.cards.liveCode(worker);
  }

  @Get("photo")
  async photo(@CurrentWorker() worker: WorkerIdentity, @Res() res: Response) {
    const photo = await this.cards.photo(worker);
    res.setHeader("Content-Type", photo.contentType);
    res.setHeader("Cache-Control", "private, no-store");
    res.send(photo.bytes);
  }

  @Post("reissue")
  @HttpCode(200)
  async reissue(@CurrentWorker() worker: WorkerIdentity) {
    await this.limits.consume("caseEditsPerWorker", `${worker.tenantId}:${worker.clientId}:${worker.phone}`);
    return this.cards.reissue(worker);
  }
}
