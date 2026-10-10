import { requireFields } from "../input-validation";
import { SurepassTransport } from "../surepass.transport";
import type { RawProviderResponse } from "../../verification-provider";

export async function verifyEmploymentHistory(transport: SurepassTransport, payload: { uan: string }): Promise<RawProviderResponse> {
  requireFields(payload, ["uan"]);
  return transport.send(`/api/v1/income/employment-history-uan-v2`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id_number: payload.uan })
  });
}
