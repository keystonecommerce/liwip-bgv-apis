import { requireFields } from "../input-validation";
import { SurepassTransport } from "../surepass.transport";
import type { RawProviderResponse } from "../../verification-provider";

export async function verifyPanComprehensive(transport: SurepassTransport, payload: { idNumber: string; maskedAadhaarVariant?: string }): Promise<RawProviderResponse> {
  requireFields(payload, ["idNumber"]);
  return transport.send(`/api/v1/pan/pan-comprehensive`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({ id_number: payload.idNumber, masked_aadhaar_variant: payload.maskedAadhaarVariant || "empty" })
  });
}
