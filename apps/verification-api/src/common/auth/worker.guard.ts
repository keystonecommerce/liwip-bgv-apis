import { CanActivate, ExecutionContext, Injectable, UnauthorizedException, createParamDecorator } from "@nestjs/common";
import { RequestWithClient } from "./client-context";
import { WorkerIdentity, readWorkerToken } from "./worker-token";

export type RequestWithWorker = RequestWithClient & { worker?: WorkerIdentity; headers: Record<string, string | string[] | undefined> };

/**
 * Runs after ApiKeyGuard. The token must belong to the same platform as the API key, with one
 * exception: a token from a redeemed partner invite, used through the Liwip worker app's own key
 * (`worker:cases`, which only Keystone can grant). The request then acts for the partner's program.
 */
@Injectable()
export class WorkerGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<RequestWithWorker>();
    const header = request.headers["x-worker-token"];
    const worker = readWorkerToken(Array.isArray(header) ? header[0] : header);
    const client = request.clientContext;
    if (!worker || !client) throw new UnauthorizedException("Sign in again with your mobile number");
    const samePlatform = worker.tenantId === client.tenantId && worker.clientId === client.clientId;
    if (!samePlatform) {
      if (!worker.invite || !client.scopes.includes("worker:cases")) throw new UnauthorizedException("Sign in again with your mobile number");
      request.clientContext = { ...client, tenantId: worker.tenantId, tenantSlug: worker.invite.tenantSlug, clientId: worker.clientId, clientCode: worker.invite.clientCode, actingForInvite: worker.invite.id };
    }
    request.worker = worker;
    return true;
  }
}

export const CurrentWorker = createParamDecorator((_data: unknown, context: ExecutionContext): WorkerIdentity => {
  const worker = context.switchToHttp().getRequest<RequestWithWorker>().worker;
  if (!worker) throw new Error("Worker identity is missing");
  return worker;
});
