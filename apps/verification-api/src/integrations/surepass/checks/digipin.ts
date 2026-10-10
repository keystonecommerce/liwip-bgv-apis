import { CheckContract, jsonRequest } from "../check-contract";

export const DIGIPIN: CheckContract = {
  type: "DIGIPIN",
  source: "https://e338ebdbb06e0ec4ec7d11b7a53702dc.apidog.io/digipin-21310590e0",
  build: input => jsonRequest("utils/digipin/", input, {"latitude":"latitude","longitude":"longitude"}, {}),
};
