import { PartnerRateLimitService } from "../security/partner-rate-limit.service";
import { Global, Module } from "@nestjs/common";
import { ApiKeyGuard } from "./api-key.guard";
import { InternalRouteGuard } from "./internal-route.guard";
import { ScopeGuard } from "./scope.guard";

@Global()
@Module({ providers: [PartnerRateLimitService, ApiKeyGuard, InternalRouteGuard, ScopeGuard], exports: [PartnerRateLimitService, ApiKeyGuard, InternalRouteGuard, ScopeGuard] })
export class AuthModule {}

