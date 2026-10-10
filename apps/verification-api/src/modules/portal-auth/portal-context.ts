import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  SetMetadata
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { PortalAuthService, PortalRole, PortalUserContext } from "./portal-auth.service";

export type RequestWithPortalUser = {
  headers: Record<string, string | string[] | undefined>;
  portalUser?: PortalUserContext;
};

export const PORTAL_ROLES = "portal_roles";

/** Restrict a portal route to specific roles. With no roles, any authenticated portal user passes. */
export const PortalRoles = (...roles: PortalRole[]) => SetMetadata(PORTAL_ROLES, roles);

/** Inject the authenticated portal user resolved by PortalAuthGuard. */
export const CurrentPortalUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): PortalUserContext => {
    const request = context.switchToHttp().getRequest<RequestWithPortalUser>();
    if (!request.portalUser) throw new Error("Authenticated portal user context is missing");
    return request.portalUser;
  }
);

@Injectable()
export class PortalAuthGuard implements CanActivate {
  constructor(
    @Inject(PortalAuthService) private readonly auth: PortalAuthService,
    @Inject(Reflector) private readonly reflector: Reflector
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithPortalUser>();
    const header = request.headers["authorization"];
    const authorization = Array.isArray(header) ? header[0] : header;
    const user = await this.auth.authenticate(authorization);

    const required = this.reflector.getAllAndOverride<PortalRole[]>(PORTAL_ROLES, [
      context.getHandler(),
      context.getClass()
    ]) || [];
    if (required.length && !required.includes(user.role)) {
      throw new ForbiddenException("This portal role cannot access this resource");
    }

    request.portalUser = user;
    return true;
  }
}
