import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { RequestWithClient } from "./client-context";
import { REQUIRED_SCOPES } from "./scopes";

@Injectable()
export class ScopeGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[]>(REQUIRED_SCOPES, [context.getHandler(), context.getClass()]) || [];
    if (!required.length) return true;
    const request = context.switchToHttp().getRequest<RequestWithClient>();
    const granted = new Set(request.clientContext?.scopes || []);
    if (required.every((scope) => granted.has(scope))) return true;
    throw new ForbiddenException("API key does not have the required scope");
  }
}
