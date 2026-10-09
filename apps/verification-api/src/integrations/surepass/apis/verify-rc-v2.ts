import { requireFields } from "../input-validation";
import { SurepassTransport } from "../surepass.transport";
import type { RawProviderResponse } from "../../verification-provider";

export async function verifyRcV2(transport: SurepassTransport, payload: { idNumber: string; enrich?: boolean }): Promise<RawProviderResponse> {
  requireFields(payload, ["idNumber"]);
  return transport.send(`/api/v1/rc/rc-v2`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({ id_number: payload.idNumber, enrich: payload.enrich === true })
  });
}
