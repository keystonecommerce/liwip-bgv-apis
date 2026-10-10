import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { Observable } from "rxjs";
import { RequestWithClient } from "../../common/auth/client-context";
import { providerCallContext } from "./provider-call.context";
@Injectable()
export class ProviderContextInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const client = context.switchToHttp().getRequest<RequestWithClient>().clientContext;
    if (!client) return next.handle();
    // A server-created correlation ID, never a body/query tenant or partner ID.
    return new Observable(subscriber => providerCallContext.run({ tenantId: client.tenantId, clientId: client.clientId, apiKeyId: client.apiKeyId, operationKey: `http_${randomUUID()}` }, () => {
      const subscription = next.handle().subscribe(subscriber);
      return () => subscription.unsubscribe();
    }));
  }
}
