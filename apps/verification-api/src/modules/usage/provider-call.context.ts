import { AsyncLocalStorage } from "node:async_hooks";
export interface ProviderCallContext {
  tenantId: string;
  clientId: string;
  apiKeyId?: string;
  applicationId?: string;
  verificationId?: string;
  operationKey: string;
}
export const providerCallContext = new AsyncLocalStorage<ProviderCallContext>();
