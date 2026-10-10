import { VerificationType } from "../domain/verification.types";
import type { AadhaarOvseInitializeData } from "./aadhaar-session.types";
import type { DigiLockerInitializeData } from "./document-session.types";
import type { SupplementaryCheckType, CheckFiles } from "../domain/supplementary-checks";
export const VERIFICATION_PROVIDER = Symbol("VERIFICATION_PROVIDER");
export interface ProviderResponse { requestId?: string; status?: "verified" | "failed" | "manual_review" | "pending"; data?: Record<string, unknown> | null; }
export interface RawProviderResponse { statusCode: number; body: Record<string, unknown> | null; }
/** Only a definite provider rejection is a failed check. Outages, unknown outcomes and our own errors go to review, never adverse. */
export const statusForProviderError = (code?: string): "FAILED" | "MANUAL_REVIEW" => code === "PROVIDER_HTTP_ERROR" ? "FAILED" : "MANUAL_REVIEW";
export interface VerificationProvider {
  readonly name: string;
  verify(type: VerificationType, payload: Record<string, unknown>): Promise<ProviderResponse>;
  executeCheck(type: SupplementaryCheckType, payload: Record<string, unknown>, files?: CheckFiles): Promise<ProviderResponse>;
  verifyDrivingLicense(payload: { idNumber: string; dob: string }): Promise<RawProviderResponse>;
  verifyGst(file: { buffer: Buffer; originalname: string; mimetype: string }): Promise<RawProviderResponse>;
  verifyEaadhaar(payload: {
    buffer: Buffer;
    originalname: string;
    mimetype: string;
    fullName: string;
    yearOfBirth: string;
  }): Promise<RawProviderResponse>;
  verifyPanComprehensive(payload: { idNumber: string; maskedAadhaarVariant?: string }): Promise<RawProviderResponse>;
  verifyVoterId(payload: { idNumber: string; fullName: string; dob: string }): Promise<RawProviderResponse>;
  verifyRcFull(payload: { idNumber: string }): Promise<RawProviderResponse>;
  verifyRcV2(payload: { idNumber: string; enrich?: boolean }): Promise<RawProviderResponse>;
  matchAddresses(payload: { address1: string; address2: string }): Promise<RawProviderResponse>;
  verifyCibilScore(payload: {
    pan: string;
    mobile: string;
    name: string;
    gender: "male" | "female";
  }): Promise<RawProviderResponse>;
  verifyPassportDetails(payload: { fileNumber: string; dob: string }): Promise<RawProviderResponse>;
  verifyFaceLiveness(payload: { buffer: Buffer; originalname: string; mimetype: string }): Promise<RawProviderResponse>;
  verifyFaceMatch(payload: {
    selfie: { buffer: Buffer; originalname: string; mimetype: string };
    idCard: { buffer: Buffer; originalname: string; mimetype: string };
    selfie2?: { buffer: Buffer; originalname: string; mimetype: string };
  }): Promise<RawProviderResponse>;
  verifyEmploymentHistory(payload: { uan: string }): Promise<RawProviderResponse>;
  verifyCurrentEmployment(payload: {
    panNumber?: string;
    mobileNumber?: string;
    uanNumber?: string;
    employerName?: string;
    employeeName?: string;
  }): Promise<RawProviderResponse>;
  searchEcourts(payload: { name: string; fatherName: string; address: string; year?: string; state?: string }): Promise<RawProviderResponse>;
  getEcourtIndividualDetails(payload: { clientId: string }): Promise<RawProviderResponse>;
  searchEcourtByCnr(payload: { cnrNumber: string; courtType: "district_court" | "high_court" }): Promise<RawProviderResponse>;
  initializeAadhaarOvse(payload: AadhaarOvseInitializeData): Promise<RawProviderResponse>;
  getAadhaarOvseStatus(clientId: string): Promise<RawProviderResponse>;
  getAadhaarOvseResult(clientId: string): Promise<RawProviderResponse>;
  initializeDigiLocker(payload: DigiLockerInitializeData): Promise<RawProviderResponse>;
}
