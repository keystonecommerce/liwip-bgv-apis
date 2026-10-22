import { CheckContract, jsonRequest } from "../check-contract";

export const NAME_MATCH: CheckContract = {
  type: "NAME_MATCH",
  source: "https://app.surepass.app/docs/kyc/name-match-16301874e0",
  build: input => jsonRequest("utils/name-matching/", input, {"name1":"name_1","name2":"name_2"}, {"name_type":"person"}),
  status: data => data.match_status === true ? "verified" : data.match_status === false ? "failed" : "manual_review",
};
