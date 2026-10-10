import { requireFields } from "../input-validation";
import { SurepassTransport } from "../surepass.transport";
import type { RawProviderResponse } from "../../verification-provider";

export async function verifyCurrentEmployment(transport: SurepassTransport, payload: {
  panNumber?: string;
  mobileNumber?: string;
  uanNumber?: string;
  employerName?: string;
  employeeName?: string;
  }): Promise<RawProviderResponse> {
  requireFields({ identifier: payload.panNumber || payload.mobileNumber || payload.uanNumber }, ["identifier"]);
  const body = {
    ...(payload.panNumber ? { pan_number: payload.panNumber } : {}),
    ...(payload.mobileNumber ? { mobile_number: payload.mobileNumber } : {}),
    ...(payload.uanNumber ? { uan_number: payload.uanNumber } : {}),
    ...(payload.employerName ? { employer_name: payload.employerName } : {}),
    ...(payload.employeeName ? { employee_name: payload.employeeName } : {})
  };
  return transport.send(`/api/v1/employment/current-employment-pan-mobile`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}
