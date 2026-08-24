import { createParamDecorator, ExecutionContext } from "@nestjs/common";

export interface ClientContext {
  tenantId: string;
  tenantSlug: string;
  clientId: string;
  clientCode: string;
  apiKeyId: string;
  scopes: string[];
}

export type RequestWithClient = Request & { clientContext?: ClientContext };

export const CurrentClient = createParamDecorator((_data: unknown, context: ExecutionContext): ClientContext => {
  const request = context.switchToHttp().getRequest<RequestWithClient>();
  if (!request.clientContext) throw new Error("Authenticated client context is missing");
  return request.clientContext;
});
