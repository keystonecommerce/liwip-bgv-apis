import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";

@Injectable()
export class InternalRouteGuard implements CanActivate {
  canActivate(_context: ExecutionContext): boolean {
    const enabled = process.env.ENABLE_INTERNAL_ROUTES === "true" || process.env.NODE_ENV !== "production";
    if (!enabled) throw new ForbiddenException("Internal development routes are disabled");
    return true;
  }
}
