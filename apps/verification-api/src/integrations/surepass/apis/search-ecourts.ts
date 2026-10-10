import { requireFields } from "../input-validation";
import { SurepassTransport } from "../surepass.transport";
import type { RawProviderResponse } from "../../verification-provider";

export async function searchEcourts(transport: SurepassTransport, payload: { name: string; fatherName: string; address: string; year?: string; state?: string }): Promise<RawProviderResponse> {
  requireFields(payload, ["name", "fatherName", "address"]);
  return transport.send(`/api/v1/ecourts/ecourt-search-v2`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: payload.name, father_name: payload.fatherName, address: payload.address, year: payload.year || "", state: payload.state || "" })
  });
}
