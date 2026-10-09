import { CheckContract, jsonRequest } from "../check-contract";

export const NAME_MATCH: CheckContract = {
  type: "NAME_MATCH",
  source: "https://e338ebdbb06e0ec4ec7d11b7a53702dc.apidog.io/name-match-16301874e0",
  build: input => jsonRequest("utils/name-matching/", input, {"name1":"name_1","name2":"name_2"}, {"name_type":"person"}),
  status: data => data.match_status === true ? "verified" : data.match_status === false ? "failed" : "manual_review",
};
