import { Global, Module } from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { UsageService } from "./usage.service";
import { ProviderCallService } from "./provider-call.service";
import { ProviderContextInterceptor } from "./provider-context.interceptor";
import { UsageController } from "./usage.controller";
@Global()
@Module({ controllers: [UsageController], providers: [UsageService, ProviderCallService, { provide: APP_INTERCEPTOR, useClass: ProviderContextInterceptor }], exports: [UsageService, ProviderCallService] })
export class UsageModule {}
