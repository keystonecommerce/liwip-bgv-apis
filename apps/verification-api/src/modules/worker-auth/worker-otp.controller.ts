import { Body, Controller, HttpCode, Inject, Post, UseGuards } from "@nestjs/common";
import { ApiKeyGuard } from "../../common/auth/api-key.guard";
import { ClientContext, CurrentClient } from "../../common/auth/client-context";
import { ScopeGuard } from "../../common/auth/scope.guard";
import { RequireScopes } from "../../common/auth/scopes";
import { WorkerOtpService } from "./worker-otp.service";

interface SendOtpBody { phone?: string }
interface VerifyOtpBody { phone?: string; otp?: string }

@Controller("v1/auth/otp")
@UseGuards(ApiKeyGuard, ScopeGuard)
export class WorkerOtpController {
  constructor(@Inject(WorkerOtpService) private readonly otp: WorkerOtpService) {}

  @Post("send")
  @HttpCode(200)
  @RequireScopes("otp:write")
  send(@Body() body: SendOtpBody, @CurrentClient() client: ClientContext) {
    return this.otp.send(body.phone || "", client);
  }

  @Post("verify")
  @HttpCode(200)
  @RequireScopes("otp:write")
  verify(@Body() body: VerifyOtpBody, @CurrentClient() client: ClientContext) {
    return this.otp.verify(body.phone || "", body.otp || "", client);
  }

  @Post("resend")
  @HttpCode(200)
  @RequireScopes("otp:write")
  resend(@Body() body: SendOtpBody, @CurrentClient() client: ClientContext) {
    return this.otp.resend(body.phone || "", client);
  }
}
