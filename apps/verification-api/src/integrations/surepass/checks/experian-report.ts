import { CheckContract, jsonRequest } from "../check-contract";

export const EXPERIAN_REPORT: CheckContract = {
  type: "EXPERIAN_REPORT",
  source: "https://e338ebdbb06e0ec4ec7d11b7a53702dc.apidog.io/credit-report-experian-16301930e0",
  build: input => jsonRequest("credit-report-experian/fetch-report", input, {"name":"name","mobile":"mobile","pan":"pan"}, {"consent":"Y"}),
};
