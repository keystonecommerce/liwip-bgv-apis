import { Global, Module } from "@nestjs/common";
import { ApiKeyGuard } from "./api-key.guard";
import { InternalRouteGuard } from "./internal-route.guard";
import { ScopeGuard } from "./scope.guard";

@Global()
@Module({ providers: [ApiKeyGuard, InternalRouteGuard, ScopeGuard], exports: [ApiKeyGuard, InternalRouteGuard, ScopeGuard] })
export class AuthModule {}
