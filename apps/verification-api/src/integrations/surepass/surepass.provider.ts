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
import { CheckFiles, SupplementaryCheckType, validateCheck } from "../../domain/supplementary-checks";
import { checkContracts } from "./check-registry";
import { matchesAnyName } from "../../domain/name-match";

type CheckStatus = NonNullable<ProviderResponse["status"]>;

/**
 * A successful lookup only proves the document exists. It passes when the name
 * on record matches the worker; anything else goes to a reviewer.
 */
function nameStatus(expected: unknown, ...returned: unknown[]): (data: Record<string, unknown>) => CheckStatus {
  const references = (Array.isArray(expected) ? expected : [expected]).filter((name) => typeof name === "string" && name.trim());
  return (data) => {
    const got = returned.map((field) => data[field as string]).find((value) => typeof value === "string" && value.trim());
    return got && matchesAnyName(got, references) ? "verified" : "manual_review";
  };
}

function isPastDate(value: unknown): boolean {
  if (typeof value !== "string" || !value) return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.getTime() < Date.now();
}

@Injectable()
export class SurepassProvider implements VerificationProvider {
  readonly name = "surepass";
  constructor(@Inject(SurepassTransport) private readonly transport: SurepassTransport) {}

  async executeCheck(type: SupplementaryCheckType, payload: Record<string, unknown>, files: CheckFiles = {}): Promise<ProviderResponse> {
    validateCheck(type, payload, files);
    const contract = checkContracts[type];
    return this.toVerificationResponse(await this.transport.request(contract.build(payload, files)), type, false,
      contract.status || (() => "manual_review"));
  }

  async verify(type: VerificationType, payload: Record<string, unknown>): Promise<ProviderResponse> {
    if (type === "AADHAAR") {
      return this.toVerificationResponse(await this.verifyEaadhaar(payload as any), "e-Aadhaar");
    }
    if (type === "PAN") {
      return this.toVerificationResponse(await this.verifyPanComprehensive({ idNumber: String(payload.idNumber) }), "PAN", false,
        nameStatus(payload.name, "full_name", "name"));
    }
    if (type === "DRIVING_LICENSE") {
      return this.toVerificationResponse(await this.verifyDrivingLicense({ idNumber: String(payload.licenseNumber), dob: String(payload.dob) }), "Driving Licence", false,
        (data) => isPastDate(data.doe) ? "manual_review" : nameStatus(payload.name, "name")(data));
    }
    if (type === "VOTER_ID") {
      return this.toVerificationResponse(await this.verifyVoterId({
        idNumber: String(payload.idNumber),
        // Surepass takes one name; matching below accepts any reference name.
        fullName: String(Array.isArray(payload.fullName) ? payload.fullName[0] ?? "" : payload.fullName),
        dob: String(payload.dob)
      }), "Voter ID", false, nameStatus(payload.fullName, "name", "name_on_card"));
    }
    if (type === "ADDRESS_MATCHING") {
      return this.toVerificationResponse(await this.matchAddresses({ address1: String(payload.address1), address2: String(payload.address2) }), "Address Matching", true);
    }
    if (type === "RC_FULL") {
      return this.toVerificationResponse(await this.verifyRcFull({ idNumber: String(payload.idNumber) }), "RC Full");
    }
    if (type === "RC_V2") {
      return this.toVerificationResponse(await this.verifyRcV2({ idNumber: String(payload.idNumber), enrich: false }), "RC V2", false,
        // The owner is often a fleet or family member, so a different name goes to review, not failed.
        nameStatus(payload.name, "owner_name"));
    }
    if (type === "CIBIL_SCORE") {
      return this.toVerificationResponse(await this.verifyCibilScore({
        pan: String(payload.pan),
        mobile: String(payload.mobile),
        name: String(payload.name),
        gender: String(payload.gender) as "male" | "female"
      }), "CIBIL Score", false, () => "manual_review");
    }
    if (type === "PASSPORT") {
      return this.toVerificationResponse(await this.verifyPassportDetails({ fileNumber: String(payload.fileNumber), dob: String(payload.dob) }), "Passport", false,
        nameStatus(payload.name, "full_name", "name"));
    }
    if (type === "FACE_LIVENESS") {
      return this.toVerificationResponse(await this.verifyFaceLiveness(payload as any), "Face Liveness", false, (data) => data.live === true ? "verified" : "failed");
    }
    if (type === "FACE_MATCH") {
      return this.toVerificationResponse(await this.verifyFaceMatch(payload as any), "Face Match", false, (data) => data.match_status === true ? "verified" : "failed");
    }
    if (type === "EMPLOYMENT_HISTORY") {
      return this.toVerificationResponse(await this.verifyEmploymentHistory({ uan: String(payload.uan) }), "Employment History");
    }
    if (type === "CURRENT_EMPLOYMENT") {
      return this.toVerificationResponse(await this.verifyCurrentEmployment({
        panNumber: payload.panNumber ? String(payload.panNumber) : undefined,
        mobileNumber: payload.mobileNumber ? String(payload.mobileNumber) : undefined,
        uanNumber: payload.uanNumber ? String(payload.uanNumber) : undefined,
        employerName: payload.employerName ? String(payload.employerName) : undefined,
        employeeName: payload.employeeName ? String(payload.employeeName) : undefined
      }), "Current Employment");
    }
    if (type === "ECOURTS_SEARCH") {
      return this.toVerificationResponse(
        await this.searchEcourts({
          name: String(payload.name),
          fatherName: String(payload.fatherName),
          address: String(payload.address),
          year: payload.year ? String(payload.year) : undefined,
          state: payload.state ? String(payload.state) : undefined
        }),
        "Court Records",
        false,
        (data) => Array.isArray(data.result) ? (data.result.length > 0 ? "manual_review" : "verified") : "manual_review"
      );
    }

    const error = new UnrecoverableError(`Surepass adapter does not support ${type} yet`) as Error & { code?: string };
    error.code = "UNSUPPORTED_VERIFICATION_TYPE";
    throw error;
  }

  private toVerificationResponse(raw: GstProviderResponse, label: string, addressMatch = false, resolveStatus?: (data: Record<string, unknown>) => NonNullable<ProviderResponse["status"]>): ProviderResponse {
    const body = raw.body as {
      success?: boolean;
      data?: Record<string, unknown> | null;
      message?: string;
      message_code?: string;
      status_code?: number;
    } | null;
    if (raw.statusCode >= 400 || body?.success === false || (typeof body?.status_code === "number" && body.status_code >= 400)) {
      const message = `Surepass ${label} could not complete the check (HTTP ${raw.statusCode})`;
      const effectiveStatus = typeof body?.status_code === "number" ? body.status_code : raw.statusCode;
      const error = (effectiveStatus !== 429
        ? new UnrecoverableError(message)
        : new Error(message)) as Error & { code?: string; providerResponse?: Record<string, unknown> | null };
      error.code = effectiveStatus === 429 || effectiveStatus >= 500 ? "PROVIDER_UNAVAILABLE" : "PROVIDER_HTTP_ERROR";
      error.providerResponse = { status_code: effectiveStatus, success: body?.success ?? false, message_code: body?.message_code ?? null, message: typeof body?.message === "string" ? body.message.slice(0, 200) : null };
      throw error;
    }
    if (body?.success !== true || !body.data || typeof body.data !== "object" || Array.isArray(body.data)) {
      const error = new UnrecoverableError(`Surepass ${label} returned an incomplete response; review before retrying`) as Error & { code?: string };
      error.code = "PROVIDER_OUTCOME_UNKNOWN";
      throw error;
    }
    return {
      requestId: typeof body.data.client_id === "string" ? body.data.client_id : undefined,
      status: resolveStatus ? resolveStatus(body.data) : addressMatch ? (body.data.match_status === true ? "verified" : body.data.match_status === false ? "failed" : "manual_review") : "manual_review",
      data: body.data
    };
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
}
