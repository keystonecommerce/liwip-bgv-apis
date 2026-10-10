import { CheckContract } from "./check-contract";
import { SupplementaryCheckType } from "../../domain/supplementary-checks";
import { NAME_MATCH } from "./checks/name-match";
import { MOBILE_NAME } from "./checks/mobile-name";
import { EMAIL_CHECK } from "./checks/email-check";
import { IFSC } from "./checks/ifsc";
import { UPI } from "./checks/upi";
import { BANK_REPORT } from "./checks/bank-report";
import { DIGIPIN } from "./checks/digipin";
import { VEHICLE_CHALLAN } from "./checks/vehicle-challan";
import { AML } from "./checks/aml";
import { PEP } from "./checks/pep";
import { DOCTOR_REGISTRATION } from "./checks/doctor-registration";
import { ICSI } from "./checks/icsi";
import { EXPERIAN_REPORT } from "./checks/experian-report";
import { CRIF_REPORT } from "./checks/crif-report";
import { AADHAAR_OCR } from "./checks/aadhaar-ocr";
import { PAN_OCR } from "./checks/pan-ocr";
import { VOTER_OCR } from "./checks/voter-ocr";
import { PASSPORT_OCR } from "./checks/passport-ocr";
import { LICENSE_OCR } from "./checks/license-ocr";
import { AADHAAR_MASK } from "./checks/aadhaar-mask";

export const checkContracts: Record<SupplementaryCheckType, CheckContract> = {
  NAME_MATCH,
  MOBILE_NAME,
  EMAIL_CHECK,
  IFSC,
  UPI,
  BANK_REPORT,
  DIGIPIN,
  VEHICLE_CHALLAN,
  AML,
  PEP,
  DOCTOR_REGISTRATION,
  ICSI,
  EXPERIAN_REPORT,
  CRIF_REPORT,
  AADHAAR_OCR,
  PAN_OCR,
  VOTER_OCR,
  PASSPORT_OCR,
  LICENSE_OCR,
  AADHAAR_MASK
};
