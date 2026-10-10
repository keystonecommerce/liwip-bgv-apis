import { CanActivate, ExecutionContext, Injectable, UnauthorizedException, createParamDecorator } from "@nestjs/common";
import { RequestWithClient } from "./client-context";
import { WorkerIdentity, readWorkerToken } from "./worker-token";

export type RequestWithWorker = RequestWithClient & { worker?: WorkerIdentity; headers: Record<string, string | string[] | undefined> };

/** Runs after ApiKeyGuard. The token must belong to the same platform as the API key. */
@Injectable()
export class WorkerGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<RequestWithWorker>();
    const header = request.headers["x-worker-token"];
    const worker = readWorkerToken(Array.isArray(header) ? header[0] : header);
    const client = request.clientContext;
    if (!worker || !client || worker.tenantId !== client.tenantId || worker.clientId !== client.clientId) {
      throw new UnauthorizedException("Sign in again with your mobile number");
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
