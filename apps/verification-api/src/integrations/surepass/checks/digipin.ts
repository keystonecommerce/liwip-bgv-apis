import { CheckContract, jsonRequest } from "../check-contract";

export const DIGIPIN: CheckContract = {
  type: "DIGIPIN",
  source: "https://app.surepass.app/docs/kyc/digipin-21310590e0",
  build: input => jsonRequest("utils/digipin/", input, {"latitude":"latitude","longitude":"longitude"}, {}),
};
