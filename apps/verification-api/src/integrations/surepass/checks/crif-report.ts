import { CheckContract, jsonRequest } from "../check-contract";

export const CRIF_REPORT: CheckContract = {
  type: "CRIF_REPORT",
  source: "https://app.surepass.app/docs/kyc/credit-report-crif-19530299e0",
  build: input => jsonRequest("credit-report-crif/fetch-report", input, {"firstName":"first_name","lastName":"last_name","mobile":"mobile","pan":"pan"}, {"consent":"Y"}),
};
