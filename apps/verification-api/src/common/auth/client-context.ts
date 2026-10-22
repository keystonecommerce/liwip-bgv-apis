import { createParamDecorator, ExecutionContext } from "@nestjs/common";

export interface ClientContext {
  tenantId: string;
  tenantSlug: string;
  clientId: string;
  clientCode: string;
  apiKeyId: string;
  scopes: string[];
  /**
   * The worker app acting for a partner's program after an invite was redeemed. Records that tie a
   * key to its own program (cases, provider calls) then carry no key id.
   */
  actingForInvite?: string;
}

export type RequestWithClient = Request & { clientContext?: ClientContext };

export const CurrentClient = createParamDecorator((_data: unknown, context: ExecutionContext): ClientContext => {
  const request = context.switchToHttp().getRequest<RequestWithClient>();
  if (!request.clientContext) throw new Error("Authenticated client context is missing");
  return request.clientContext;
});
