import { SurepassTransport } from "../surepass.transport";
import type { RawProviderResponse } from "../../verification-provider";

/** Electricity boards (state and operator_code) for the electricity bill check. */
export async function listElectricityOperators(transport: SurepassTransport): Promise<RawProviderResponse> {
  return transport.send(`/api/v1/utility/electricity/operator-code-list`, {
    method: "GET"
  });
}
