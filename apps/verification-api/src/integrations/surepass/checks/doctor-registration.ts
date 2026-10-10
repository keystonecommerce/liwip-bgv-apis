import { CheckContract, jsonRequest } from "../check-contract";

export const DOCTOR_REGISTRATION: CheckContract = {
  type: "DOCTOR_REGISTRATION",
  source: "https://e338ebdbb06e0ec4ec7d11b7a53702dc.apidog.io/doctor-verification-16301979e0",
  build: input => jsonRequest("doctor/doctor-verification", input, {"registrationNumber":"registration_number","registrationYear":"registration_year"}, {}),
};
