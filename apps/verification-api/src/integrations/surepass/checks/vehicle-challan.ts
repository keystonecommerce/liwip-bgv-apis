import { CheckContract, jsonRequest } from "../check-contract";

export const VEHICLE_CHALLAN: CheckContract = {
  type: "VEHICLE_CHALLAN",
  source: "https://e338ebdbb06e0ec4ec7d11b7a53702dc.apidog.io/rc-challan-16301781e0",
  build: input => jsonRequest("rc/rc-related/challan-details", input, {"registrationNumber":"rc_number","chassisNumber":"chassis_number","engineNumber":"engine_number"}, {"state_only":false,"state_portal":["DL","TS","KA","GJ"]}),
};
