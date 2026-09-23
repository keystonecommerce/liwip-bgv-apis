import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";

@Injectable()
export class InternalRouteGuard implements CanActivate {
  canActivate(_context: ExecutionContext): boolean {
    // Never expose the unauthenticated internal/provider-test routes in
    // production, even if the flag is left on by mistake: require BOTH a
    // non-production environment AND the explicit opt-in flag.
    const enabled = process.env.NODE_ENV !== "production" && process.env.ENABLE_INTERNAL_ROUTES === "true";
    if (!enabled) throw new ForbiddenException("Internal development routes are disabled");
    return true;
  }
}
