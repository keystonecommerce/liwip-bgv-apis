import type { Verifier } from "../verifier";
import { challanStatus, VEHICLE_CHALLAN as CHALLAN_CHECK } from "../checks/vehicle-challan";

/** Same request and verdict as the VEHICLE_CHALLAN supplementary check, on the case's vehicle number. */
export const VEHICLE_CHALLAN: Verifier = {
  type: "VEHICLE_CHALLAN",
  label: "Vehicle Challan",
  call: (transport, payload) => transport.request(CHALLAN_CHECK.build({ registrationNumber: String(payload.registrationNumber) }, {})),
  verdict: () => challanStatus
};
