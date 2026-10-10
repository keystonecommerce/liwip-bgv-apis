import { requireFields } from "../input-validation";
import { SurepassTransport } from "../surepass.transport";
import type { RawProviderResponse } from "../../verification-provider";

export async function verifyRcFull(transport: SurepassTransport, payload: { idNumber: string }): Promise<RawProviderResponse> {
  requireFields(payload, ["idNumber"]);
  return transport.send(`/api/v1/rc/rc-full`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({ id_number: payload.idNumber })
  });
}
