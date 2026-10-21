import { Inject, Injectable } from "@nestjs/common";
import { VerificationType } from "../../domain/verification.types";
import { UnrecoverableError } from "bullmq";
import type { AadhaarOvseInitializeData } from "./aadhaar-ovse.types";
import type { DigiLockerInitializeData } from "./digilocker.types";

import { SurepassTransport } from "./surepass.transport";
import { ProviderResponse, RawProviderResponse as GstProviderResponse, VerificationProvider } from "../verification-provider";
export type { ProviderResponse, RawProviderResponse as GstProviderResponse, VerificationProvider } from "../verification-provider";
import { verifyDrivingLicense } from "./apis/verify-driving-license";
import { verifyGst } from "./apis/verify-gst";
import { verifyEaadhaar } from "./apis/verify-eaadhaar";
import { verifyPanComprehensive } from "./apis/verify-pan-comprehensive";
import { verifyVoterId } from "./apis/verify-voter-id";
import { verifyRcFull } from "./apis/verify-rc-full";
import { verifyRcV2 } from "./apis/verify-rc-v2";
import { matchAddresses } from "./apis/match-addresses";
import { verifyCibilScore } from "./apis/verify-cibil-score";
import { verifyPassportDetails } from "./apis/verify-passport-details";
import { verifyFaceLiveness } from "./apis/verify-face-liveness";
import { verifyFaceMatch } from "./apis/verify-face-match";
import { verifyEmploymentHistory } from "./apis/verify-employment-history";
import { verifyCurrentEmployment } from "./apis/verify-current-employment";
import { searchEcourts } from "./apis/search-ecourts";
import { getEcourtIndividualDetails } from "./apis/get-ecourt-individual-details";
import { searchEcourtByCnr } from "./apis/search-ecourt-by-cnr";
import { initializeAadhaarOvse } from "./apis/initialize-aadhaar-ovse";
import { getAadhaarOvseStatus } from "./apis/get-aadhaar-ovse-status";
import { getAadhaarOvseResult } from "./apis/get-aadhaar-ovse-result";
import { initializeDigiLocker } from "./apis/initialize-digi-locker";
import { listElectricityOperators } from "./apis/list-electricity-operators";
import { CheckFiles, SupplementaryCheckType, validateCheck } from "../../domain/supplementary-checks";
import { checkContracts } from "./check-registry";
import { verifiers } from "./verifier-registry";
import { toProviderResponse } from "./surepass-response";

@Injectable()
export class SurepassProvider implements VerificationProvider {
  readonly name = "surepass";
  constructor(@Inject(SurepassTransport) private readonly transport: SurepassTransport) {}

  async executeCheck(type: SupplementaryCheckType, payload: Record<string, unknown>, files: CheckFiles = {}): Promise<ProviderResponse> {
    validateCheck(type, payload, files);
    const contract = checkContracts[type];
    return toProviderResponse(await this.transport.request(contract.build(payload, files)), type, contract.status);
  }

  /** Runs a queued check through its verifier (see verifier-registry.ts). */
  async verify(type: VerificationType, payload: Record<string, unknown>): Promise<ProviderResponse> {
    const verifier = verifiers[type];
    if (!verifier) {
      const error = new UnrecoverableError(`Surepass adapter does not support ${type} yet`) as Error & { code?: string };
      error.code = "UNSUPPORTED_VERIFICATION_TYPE";
      throw error;
    }
    return toProviderResponse(await verifier.call(this.transport, payload), verifier.label, verifier.verdict?.(payload));
  }

  async verifyDrivingLicense(payload: { idNumber: string; dob: string }): Promise<GstProviderResponse> {
    return verifyDrivingLicense(this.transport, payload);
  }

  async verifyGst(file: { buffer: Buffer; originalname: string; mimetype: string }): Promise<GstProviderResponse> {
    return verifyGst(this.transport, file);
  }

  async verifyEaadhaar(payload: {
    buffer: Buffer;
    originalname: string;
    mimetype: string;
    fullName: string;
    yearOfBirth: string;
  }): Promise<GstProviderResponse> {
    return verifyEaadhaar(this.transport, payload);
  }

  async verifyPanComprehensive(payload: { idNumber: string; maskedAadhaarVariant?: string }): Promise<GstProviderResponse> {
    return verifyPanComprehensive(this.transport, payload);
  }

  async verifyVoterId(payload: { idNumber: string; fullName: string; dob: string }): Promise<GstProviderResponse> {
    return verifyVoterId(this.transport, payload);
  }

  async verifyRcFull(payload: { idNumber: string }): Promise<GstProviderResponse> {
    return verifyRcFull(this.transport, payload);
  }

  async verifyRcV2(payload: { idNumber: string; enrich?: boolean }): Promise<GstProviderResponse> {
    return verifyRcV2(this.transport, payload);
  }

  async matchAddresses(payload: { address1: string; address2: string }): Promise<GstProviderResponse> {
    return matchAddresses(this.transport, payload);
  }

  async verifyCibilScore(payload: {
    pan: string;
    mobile: string;
    name: string;
    gender: "male" | "female";
  }): Promise<GstProviderResponse> {
    return verifyCibilScore(this.transport, payload);
  }

  async verifyPassportDetails(payload: { fileNumber: string; dob: string }): Promise<GstProviderResponse> {
    return verifyPassportDetails(this.transport, payload);
  }

  async verifyFaceLiveness(payload: { buffer: Buffer; originalname: string; mimetype: string }): Promise<GstProviderResponse> {
    return verifyFaceLiveness(this.transport, payload);
  }

  async verifyFaceMatch(payload: {
    selfie: { buffer: Buffer; originalname: string; mimetype: string };
    idCard: { buffer: Buffer; originalname: string; mimetype: string };
    selfie2?: { buffer: Buffer; originalname: string; mimetype: string };
  }): Promise<GstProviderResponse> {
    return verifyFaceMatch(this.transport, payload);
  }

  async verifyEmploymentHistory(payload: { uan: string }): Promise<GstProviderResponse> {
    return verifyEmploymentHistory(this.transport, payload);
  }

  async verifyCurrentEmployment(payload: {
    panNumber?: string;
    mobileNumber?: string;
    uanNumber?: string;
    employerName?: string;
    employeeName?: string;
  }): Promise<GstProviderResponse> {
    return verifyCurrentEmployment(this.transport, payload);
  }

  async searchEcourts(payload: { name: string; fatherName: string; address: string; year?: string; state?: string }): Promise<GstProviderResponse> {
    return searchEcourts(this.transport, payload);
  }

  async getEcourtIndividualDetails(payload: { clientId: string }): Promise<GstProviderResponse> {
    return getEcourtIndividualDetails(this.transport, payload);
  }

  async searchEcourtByCnr(payload: { cnrNumber: string; courtType: "district_court" | "high_court" }): Promise<GstProviderResponse> {
    return searchEcourtByCnr(this.transport, payload);
  }

  async initializeAadhaarOvse(payload: AadhaarOvseInitializeData): Promise<GstProviderResponse> {
    return initializeAadhaarOvse(this.transport, payload);
  }

  async getAadhaarOvseStatus(clientId: string): Promise<GstProviderResponse> {
    return getAadhaarOvseStatus(this.transport, clientId);
  }

  async getAadhaarOvseResult(clientId: string): Promise<GstProviderResponse> {
    return getAadhaarOvseResult(this.transport, clientId);
  }

  async initializeDigiLocker(payload: DigiLockerInitializeData): Promise<GstProviderResponse> {
    return initializeDigiLocker(this.transport, payload);
  }

  async listElectricityOperators(): Promise<GstProviderResponse> {
    return listElectricityOperators(this.transport);
  }
}
