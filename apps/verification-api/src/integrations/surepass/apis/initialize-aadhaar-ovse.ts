import { SurepassTransport } from "../surepass.transport";
import type { RawProviderResponse } from "../../verification-provider";
import type { AadhaarOvseInitializeData } from "../../aadhaar-session.types";

export async function initializeAadhaarOvse(transport: SurepassTransport, payload: AadhaarOvseInitializeData): Promise<RawProviderResponse> {
  return transport.send(`/api/v1/aadhaar-v4/initialize`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
}
