import { Body, Controller, HttpCode, Inject, Post, UseGuards } from "@nestjs/common";
import { ApiKeyGuard } from "../../common/auth/api-key.guard";
import { ClientContext, CurrentClient } from "../../common/auth/client-context";
import { ScopeGuard } from "../../common/auth/scope.guard";
import { RequireScopes } from "../../common/auth/scopes";
import { EndUserIp, RateLimitService } from "../../common/security/rate-limit.service";
import { WorkerOtpService } from "./worker-otp.service";

interface SendOtpBody { phone?: string }
interface VerifyOtpBody { phone?: string; otp?: string }

@Controller("v1/auth/otp")
@UseGuards(ApiKeyGuard, ScopeGuard)
export class WorkerOtpController {
  constructor(
    @Inject(WorkerOtpService) private readonly otp: WorkerOtpService,
    @Inject(RateLimitService) private readonly limits: RateLimitService
  ) {}

  @Post("send")
  @HttpCode(200)
  @RequireScopes("otp:write")
  async send(@Body() body: SendOtpBody, @CurrentClient() client: ClientContext, @EndUserIp() ip: string) {
    await this.limits.consume("otpSendPerIp", ip);
    return this.otp.send(body.phone || "", client);
  }

  @Post("verify")
  @HttpCode(200)
  @RequireScopes("otp:write")
  async verify(@Body() body: VerifyOtpBody, @CurrentClient() client: ClientContext, @EndUserIp() ip: string) {
    await this.limits.consume("otpVerifyPerIp", ip);
    return this.otp.verify(body.phone || "", body.otp || "", client);
  }

  @Post("resend")
  @HttpCode(200)
  @RequireScopes("otp:write")
  async resend(@Body() body: SendOtpBody, @CurrentClient() client: ClientContext, @EndUserIp() ip: string) {
    await this.limits.consume("otpSendPerIp", ip);
    return this.otp.resend(body.phone || "", client);
  }
}
