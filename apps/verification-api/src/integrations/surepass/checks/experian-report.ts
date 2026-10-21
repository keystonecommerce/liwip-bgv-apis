import { CheckContract, jsonRequest } from "../check-contract";

export const EXPERIAN_REPORT: CheckContract = {
  type: "EXPERIAN_REPORT",
  source: "https://app.surepass.app/docs/kyc/credit-report-experian-16301930e0",
  build: input => jsonRequest("credit-report-experian/fetch-report", input, {"name":"name","mobile":"mobile","pan":"pan"}, {"consent":"Y"}),
};
