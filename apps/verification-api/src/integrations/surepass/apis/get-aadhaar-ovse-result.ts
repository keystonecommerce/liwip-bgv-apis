import { requireFields } from "../input-validation";
import { SurepassTransport } from "../surepass.transport";
import type { RawProviderResponse } from "../../verification-provider";

export async function getAadhaarOvseResult(transport: SurepassTransport, clientId: string): Promise<RawProviderResponse> {
  requireFields({ clientId }, ["clientId"]);
  const query = new URLSearchParams({ client_id: clientId });
  return transport.send(`/api/v1/aadhaar-v4/result?${query.toString()}`, {
    method: "GET"
  });
}
