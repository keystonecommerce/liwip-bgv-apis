import { requireFields } from "../input-validation";
import { SurepassTransport } from "../surepass.transport";
import type { RawProviderResponse } from "../../verification-provider";

export async function verifyPassportDetails(transport: SurepassTransport, payload: { fileNumber: string; dob: string }): Promise<RawProviderResponse> {
  requireFields(payload, ["fileNumber", "dob"]);
  return transport.send(`/api/v1/passport/passport/passport-details`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({ id_number: payload.fileNumber, dob: payload.dob })
  });
}
