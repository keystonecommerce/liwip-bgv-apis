import { requireFields } from "../input-validation";
import { SurepassTransport } from "../surepass.transport";
import type { RawProviderResponse } from "../../verification-provider";

export async function getEcourtIndividualDetails(transport: SurepassTransport, payload: { clientId: string }): Promise<RawProviderResponse> {
  requireFields(payload, ["clientId"]);
  return transport.send(`/api/v1/ecourts/ecourt-individual-court-details`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: payload.clientId })
  });
}
