import { Body, Controller, HttpCode, Inject, Post, UseGuards } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { ApiKeyGuard } from "../../common/auth/api-key.guard";
import { ClientContext, CurrentClient } from "../../common/auth/client-context";
import { ScopeGuard } from "../../common/auth/scope.guard";
import { RequireScopes } from "../../common/auth/scopes";
import { CurrentWorker, WorkerGuard } from "../../common/auth/worker.guard";
import type { WorkerIdentity } from "../../common/auth/worker-token";
import { EndUserIp, RateLimitService } from "../../common/security/rate-limit.service";
import { WorkerPasskeyService } from "./worker-passkey.service";

/** Quick sign-in with a passkey. Setting one up needs a worker who already passed OTP. */
@Controller("v1/worker/passkeys")
@UseGuards(ApiKeyGuard, ScopeGuard)
@RequireScopes("worker:cases")
export class WorkerPasskeyController {
  constructor(
    @Inject(WorkerPasskeyService) private readonly passkeys: WorkerPasskeyService,
    @Inject(RateLimitService) private readonly limits: RateLimitService
  ) {}

  @Post("register/options")
  @HttpCode(200)
  @UseGuards(WorkerGuard)
  async registrationOptions(@CurrentWorker() worker: WorkerIdentity, @Body() body: { displayName?: string }) {
    await this.limits.consume("passkeySetupPerWorker", `${worker.tenantId}:${worker.clientId}:${worker.phone}`);
    return this.passkeys.registrationOptions(worker, body?.displayName);
  }

  @Post("register/verify")
  @HttpCode(200)
  @UseGuards(WorkerGuard)
  verifyRegistration(@CurrentWorker() worker: WorkerIdentity, @Body() body: RegistrationResponseJSON) {
    return this.passkeys.verifyRegistration(worker, body);
  }

  @Post("login/options")
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async authenticationOptions(@CurrentClient() client: ClientContext, @EndUserIp() ip: string) {
    await this.limits.consume("passkeyLoginPerIp", ip);
    return this.passkeys.authenticationOptions(client);
  }

  @Post("login/verify")
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async verifyAuthentication(@CurrentClient() client: ClientContext, @Body() body: AuthenticationResponseJSON, @EndUserIp() ip: string) {
    await this.limits.consume("passkeyLoginPerIp", ip);
    return this.passkeys.verifyAuthentication(client, body);
  }
}
