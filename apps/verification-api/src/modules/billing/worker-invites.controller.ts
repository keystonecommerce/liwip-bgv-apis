import { Controller, Get, HttpCode, Inject, Param, Post, UseGuards } from "@nestjs/common";
import { ApiKeyGuard } from "../../common/auth/api-key.guard";
import { ScopeGuard } from "../../common/auth/scope.guard";
import { RequireScopes } from "../../common/auth/scopes";
import { CurrentWorker, WorkerGuard } from "../../common/auth/worker.guard";
import type { WorkerIdentity } from "../../common/auth/worker-token";
import { InviteRedemptionService } from "./invite-redemption.service";

/**
 * The Liwip worker app opening a partner's invite. Its own key (worker:cases) is required, so
 * only the worker app's server can call these; redeeming also needs the person signed in.
 */
@Controller("v1/worker/invites")
@UseGuards(ApiKeyGuard, ScopeGuard)
@RequireScopes("worker:cases")
export class WorkerInvitesController {
  constructor(@Inject(InviteRedemptionService) private readonly redemption: InviteRedemptionService) {}

  /** Before sign-in: whose link this is and whether it still works. */
  @Get(":token")
  preview(@Param("token") token: string) {
    return this.redemption.preview(String(token));
  }

  @Post(":token/redeem")
  @HttpCode(200)
  @UseGuards(WorkerGuard)
  redeem(@CurrentWorker() worker: WorkerIdentity, @Param("token") token: string) {
    return this.redemption.redeem(worker, String(token));
  }
}
