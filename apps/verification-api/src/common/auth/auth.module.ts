import { PartnerRateLimitService } from "../security/partner-rate-limit.service";
import { Global, Module } from "@nestjs/common";
import { ApiKeyGuard } from "./api-key.guard";
import { InternalRouteGuard } from "./internal-route.guard";
import { ScopeGuard } from "./scope.guard";
import { WorkerGuard } from "./worker.guard";

@Global()
@Module({ providers: [PartnerRateLimitService, ApiKeyGuard, InternalRouteGuard, ScopeGuard, WorkerGuard], exports: [PartnerRateLimitService, ApiKeyGuard, InternalRouteGuard, ScopeGuard, WorkerGuard] })
export class AuthModule {}

