import { requireFields } from "../input-validation";
import { SurepassTransport } from "../surepass.transport";
import type { RawProviderResponse } from "../../verification-provider";

export async function verifyCibilScore(transport: SurepassTransport, payload: {
  pan: string;
  mobile: string;
  name: string;
  gender: "male" | "female";
  }): Promise<RawProviderResponse> {
  requireFields(payload, ["pan", "mobile", "name", "gender"]);
  return transport.send(`/api/v1/credit-report-cibil/score`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      pan: payload.pan,
      mobile: payload.mobile,
      name: payload.name,
      consent: "Y",
      gender: payload.gender
    })
  });
}
