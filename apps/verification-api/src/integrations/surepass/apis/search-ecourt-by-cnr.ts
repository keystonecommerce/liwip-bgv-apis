import { requireFields } from "../input-validation";
import { SurepassTransport } from "../surepass.transport";
import type { RawProviderResponse } from "../../verification-provider";

export async function searchEcourtByCnr(transport: SurepassTransport, payload: { cnrNumber: string; courtType: "district_court" | "high_court" }): Promise<RawProviderResponse> {
  requireFields(payload, ["cnrNumber", "courtType"]);
  return transport.send(`/api/v1/ecourts/ecourt-cnr-search-adv`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cnr_number: payload.cnrNumber, court_type: payload.courtType })
  });
}
