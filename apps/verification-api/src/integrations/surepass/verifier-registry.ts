import type { VerificationType } from "../../domain/verification.types";
import type { Verifier } from "./verifier";
import { AADHAAR } from "./verifiers/aadhaar";
import { PAN } from "./verifiers/pan";
import { DRIVING_LICENSE } from "./verifiers/driving-license";
import { VOTER_ID } from "./verifiers/voter-id";
import { ADDRESS_MATCHING } from "./verifiers/address-matching";
import { RC_FULL } from "./verifiers/rc-full";
import { RC_V2 } from "./verifiers/rc-v2";
import { VEHICLE_CHALLAN } from "./verifiers/vehicle-challan";
import { ELECTRICITY_BILL } from "./verifiers/electricity-bill";
import { CIBIL_SCORE } from "./verifiers/cibil-score";
import { PASSPORT } from "./verifiers/passport";
import { FACE_LIVENESS } from "./verifiers/face-liveness";
import { FACE_MATCH } from "./verifiers/face-match";
import { EMPLOYMENT_HISTORY } from "./verifiers/employment-history";
import { CURRENT_EMPLOYMENT } from "./verifiers/current-employment";
import { ECOURTS_SEARCH } from "./verifiers/ecourts-search";

/** Queued checks Surepass runs. A type not listed has no Surepass adapter. */
export const verifiers: Partial<Record<VerificationType, Verifier>> = {
  AADHAAR,
  PAN,
  DRIVING_LICENSE,
  VOTER_ID,
  ADDRESS_MATCHING,
  RC_FULL,
  RC_V2,
  VEHICLE_CHALLAN,
  ELECTRICITY_BILL,
  CIBIL_SCORE,
  PASSPORT,
  FACE_LIVENESS,
  FACE_MATCH,
  EMPLOYMENT_HISTORY,
  CURRENT_EMPLOYMENT,
  ECOURTS_SEARCH
};
