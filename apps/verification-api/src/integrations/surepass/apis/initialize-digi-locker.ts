import { SurepassTransport } from "../surepass.transport";
import type { RawProviderResponse } from "../../verification-provider";
import type { DigiLockerInitializeData } from "../../document-session.types";

export async function initializeDigiLocker(transport: SurepassTransport, payload: DigiLockerInitializeData): Promise<RawProviderResponse> {
  return transport.send(`/api/v1/digilocker/initialize`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ data: payload })
  });
}
