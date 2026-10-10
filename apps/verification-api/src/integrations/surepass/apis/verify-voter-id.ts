import { requireFields } from "../input-validation";
import { SurepassTransport } from "../surepass.transport";
import type { RawProviderResponse } from "../../verification-provider";

export async function verifyVoterId(transport: SurepassTransport, payload: { idNumber: string; fullName: string; dob: string }): Promise<RawProviderResponse> {
  requireFields(payload, ["idNumber", "fullName", "dob"]);
  return transport.send(`/api/v1/voter-id/voter-id`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id_number: payload.idNumber,
      additional_details: {
        full_name: payload.fullName,
        dob: payload.dob
      }
    })
  });
}
