import { requireFields } from "../input-validation";
import { SurepassTransport } from "../surepass.transport";
import type { RawProviderResponse } from "../../verification-provider";

export async function verifyDrivingLicense(transport: SurepassTransport, payload: { idNumber: string; dob: string }): Promise<RawProviderResponse> {
  requireFields(payload, ["idNumber", "dob"]);
  return transport.send(`/api/v1/driving-license/driving-license`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id_number: payload.idNumber, dob: payload.dob })
  });
}
