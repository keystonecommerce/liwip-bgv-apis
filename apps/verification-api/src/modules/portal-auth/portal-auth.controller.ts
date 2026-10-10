import { Body, Controller, Get, Headers, Inject, Post } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { PortalAuthService } from "./portal-auth.service";

@Controller("v1/portal-auth")
export class PortalAuthController {
  constructor(@Inject(PortalAuthService) private readonly auth: PortalAuthService) {}

  @Post("login")
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  login(@Body() body: { email?: string; password?: string; role?: string }) {
    return this.auth.login(body);
  }

  @Get("me")
  me(@Headers("authorization") authorization?: string) {
    return this.auth.me(authorization);
  }
}
