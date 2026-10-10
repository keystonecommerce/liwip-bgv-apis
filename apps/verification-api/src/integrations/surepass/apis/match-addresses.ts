import { requireFields } from "../input-validation";
import { SurepassTransport } from "../surepass.transport";
import type { RawProviderResponse } from "../../verification-provider";

export async function matchAddresses(transport: SurepassTransport, payload: { address1: string; address2: string }): Promise<RawProviderResponse> {
  requireFields(payload, ["address1", "address2"]);
  return transport.send(`/api/v1/utils/address-matching`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({ address_1: payload.address1, address_2: payload.address2 })
  });
}
