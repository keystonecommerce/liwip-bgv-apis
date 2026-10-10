import { ProviderCallService } from "../../modules/usage/provider-call.service";
import { Inject, Injectable } from "@nestjs/common";
import { VerificationType } from "../../domain/verification.types";
import { UnrecoverableError } from "bullmq";
import type { AadhaarOvseInitializeData } from "./aadhaar-ovse.types";
import type { DigiLockerInitializeData } from "./digilocker.types";

export interface ProviderResponse {
  requestId?: string;
  status?: string;
  data?: Record<string, unknown> | null;
}

export interface GstProviderResponse {
  statusCode: number;
  body: Record<string, unknown> | null;
}

export interface VerificationProvider {
  verify(type: VerificationType, payload: Record<string, unknown>): Promise<ProviderResponse>;
}

@Injectable()
export class SurepassProvider implements VerificationProvider {
  constructor(@Inject(ProviderCallService) private readonly calls: ProviderCallService) {}

  private readonly baseUrl = process.env.SUREPASS_BASE_URL || "https://sandbox.surepass.app";
  private readonly bearerToken = process.env.SUREPASS_BEARER_TOKEN;
  private readonly customerId = process.env.SUREPASS_CUSTOMER_ID;
  private static readonly REQUEST_TIMEOUT_MS = Number(process.env.SUREPASS_TIMEOUT_MS || 20000);

  // Bound every provider call so a slow/hung socket can't pin a BullMQ worker
  // slot indefinitely. A timeout surfaces as a recoverable error → BullMQ retries.
  private async timedFetch(url: string, init: RequestInit = {}): Promise<Response> {
    const operation = new URL(url).pathname;
    return this.calls.dispatch("surepass", operation, () => fetch(url, { ...init, signal: AbortSignal.timeout(SurepassProvider.REQUEST_TIMEOUT_MS) }));
  }

  async verify(type: VerificationType, payload: Record<string, unknown>): Promise<ProviderResponse> {
    if (!this.bearerToken) {
      const error = new Error("SUREPASS_BEARER_TOKEN is not configured") as Error & { code?: string };
      error.code = "PROVIDER_CONFIGURATION_ERROR";
      throw error;
    }

    if (type === "AADHAAR") {
      return this.toVerificationResponse(await this.verifyEaadhaar(payload as any), "e-Aadhaar");
    }
    if (type === "PAN") {
      return this.toVerificationResponse(await this.verifyPanComprehensive({ idNumber: String(payload.idNumber) }), "PAN");
    }
    if (type === "DRIVING_LICENSE") {
      return this.toVerificationResponse(await this.verifyDrivingLicense({ idNumber: String(payload.licenseNumber), dob: String(payload.dob) }), "Driving Licence");
    }
    if (type === "VOTER_ID") {
      return this.toVerificationResponse(await this.verifyVoterId({
        idNumber: String(payload.idNumber),
        fullName: String(payload.fullName),
        dob: String(payload.dob)
      }), "Voter ID");
    }
    if (type === "ADDRESS_MATCHING") {
      return this.toVerificationResponse(await this.matchAddresses({ address1: String(payload.address1), address2: String(payload.address2) }), "Address Matching", true);
    }
    if (type === "RC_FULL") {
      return this.toVerificationResponse(await this.verifyRcFull({ idNumber: String(payload.idNumber) }), "RC Full");
    }
    if (type === "RC_V2") {
      return this.toVerificationResponse(await this.verifyRcV2({ idNumber: String(payload.idNumber), enrich: false }), "RC V2");
    }
    if (type === "CIBIL_SCORE") {
      return this.toVerificationResponse(await this.verifyCibilScore({
        pan: String(payload.pan),
        mobile: String(payload.mobile),
        name: String(payload.name),
        gender: String(payload.gender) as "male" | "female"
      }), "CIBIL Score");
    }
    if (type === "PASSPORT") {
      return this.toVerificationResponse(await this.verifyPassportDetails({ fileNumber: String(payload.fileNumber), dob: String(payload.dob) }), "Passport");
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
        (data) => Array.isArray(data.result) && data.result.length > 0 ? "manual_review" : "verified"
      );
    }

    const error = new Error(`Surepass adapter does not support ${type} yet`) as Error & { code?: string };
    error.code = "UNSUPPORTED_VERIFICATION_TYPE";
    throw error;
  }

  private toVerificationResponse(raw: GstProviderResponse, label: string, addressMatch = false, resolveStatus?: (data: Record<string, unknown>) => string): ProviderResponse {
    const body = raw.body as {
      success?: boolean;
      data?: Record<string, unknown> | null;
      message?: string;
      message_code?: string;
      status_code?: number;
    } | null;
    if (raw.statusCode >= 400 || body?.success === false) {
      const details = JSON.stringify({
        status_code: body?.status_code || raw.statusCode,
        message: body?.message || "verification failed",
        message_code: body?.message_code,
        success: body?.success
      });
      const message = `Surepass ${label} returned HTTP ${raw.statusCode}: ${details}`;
      const error = (raw.statusCode !== 429
        ? new UnrecoverableError(message)
        : new Error(message)) as Error & { code?: string; providerResponse?: Record<string, unknown> | null };
      error.code = raw.statusCode === 429 || raw.statusCode >= 500 ? "PROVIDER_UNAVAILABLE" : "PROVIDER_HTTP_ERROR";
      error.providerResponse = body;
      throw error;
    }
    if (!body?.data || typeof body.data !== "object") {
      const error = new Error(`Surepass ${label} returned a malformed response`) as Error & { code?: string };
      error.code = "MALFORMED_PROVIDER_RESPONSE";
      throw error;
    }
    return {
      requestId: typeof body.data.client_id === "string" ? body.data.client_id : undefined,
      status: resolveStatus ? resolveStatus(body.data) : addressMatch && body.data.match_status === false ? "failed" : "verified",
      data: body.data
    };
  }

  async verifyDrivingLicense(payload: { idNumber: string; dob: string }): Promise<GstProviderResponse> {
    if (!this.bearerToken) throw new Error("SUREPASS_BEARER_TOKEN is not configured");

    const headers: Record<string, string> = {
      "content-type": "application/json",
      authorization: `Bearer ${this.bearerToken}`
    };
    if (this.customerId) headers["X-Customer-Id"] = this.customerId;

    const response = await this.timedFetch(`${this.baseUrl}/api/v1/driving-license/driving-license`, {
      method: "POST",
      headers,
      body: JSON.stringify({ id_number: payload.idNumber, dob: payload.dob })
    });
    const body = await response.json().catch(() => null) as Record<string, unknown> | null;
    return { statusCode: response.status, body };
  }

  async verifyGst(file: { buffer: Buffer; originalname: string; mimetype: string }): Promise<GstProviderResponse> {
    if (!this.bearerToken) throw new Error("SUREPASS_BEARER_TOKEN is not configured");

    const form = new FormData();
    const bytes = new Uint8Array(file.buffer.length);
    bytes.set(file.buffer);
    const blob = new Blob([bytes], { type: file.mimetype || "application/octet-stream" });
    form.append("file", blob, file.originalname || "gst-certificate");

    const response = await this.timedFetch(`${this.baseUrl}/api/v1/ocr/gst`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.bearerToken}` },
      body: form
    });
    const body = await response.json().catch(() => null) as Record<string, unknown> | null;
    return { statusCode: response.status, body };
  }

  async verifyEaadhaar(payload: {
    buffer: Buffer;
    originalname: string;
    mimetype: string;
    fullName: string;
    yearOfBirth: string;
  }): Promise<GstProviderResponse> {
    if (!this.bearerToken) throw new Error("SUREPASS_BEARER_TOKEN is not configured");

    const form = new FormData();
    const bytes = new Uint8Array(payload.buffer.length);
    bytes.set(payload.buffer);
    const blob = new Blob([bytes], { type: payload.mimetype || "application/pdf" });
    const fileField = process.env.SUREPASS_EAADHAAR_FILE_FIELD || "file";
    form.append(fileField, blob, payload.originalname || "eaadhaar.pdf");
    form.append("base64", payload.buffer.toString("base64"));
    form.append("yob", payload.yearOfBirth);
    form.append("full_name", payload.fullName);

    const response = await this.timedFetch(`${this.baseUrl}/api/v1/aadhaar/upload/eaadhaar`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.bearerToken}` },
      body: form
    });
    const body = await response.json().catch(() => null) as Record<string, unknown> | null;
    return { statusCode: response.status, body };
  }

  async verifyPanComprehensive(payload: { idNumber: string; maskedAadhaarVariant?: string }): Promise<GstProviderResponse> {
    if (!this.bearerToken) throw new Error("SUREPASS_BEARER_TOKEN is not configured");

    const response = await this.timedFetch(`${this.baseUrl}/api/v1/pan/pan-comprehensive`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.bearerToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ id_number: payload.idNumber, masked_aadhaar_variant: payload.maskedAadhaarVariant || "empty" })
    });
    const body = await response.json().catch(() => null) as Record<string, unknown> | null;
    return { statusCode: response.status, body };
  }

  async verifyVoterId(payload: { idNumber: string; fullName: string; dob: string }): Promise<GstProviderResponse> {
    if (!this.bearerToken) throw new Error("SUREPASS_BEARER_TOKEN is not configured");

    const headers: Record<string, string> = {
      authorization: `Bearer ${this.bearerToken}`,
      "content-type": "application/json"
    };
    if (this.customerId) headers["X-Customer-Id"] = this.customerId;

    const response = await this.timedFetch(`${this.baseUrl}/api/v1/voter-id/voter-id`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        id_number: payload.idNumber,
        additional_details: {
          full_name: payload.fullName,
          dob: payload.dob
        }
      })
    });
    const body = await response.json().catch(() => null) as Record<string, unknown> | null;
    return { statusCode: response.status, body };
  }

  async verifyRcFull(payload: { idNumber: string }): Promise<GstProviderResponse> {
    if (!this.bearerToken) throw new Error("SUREPASS_BEARER_TOKEN is not configured");

    const response = await this.timedFetch(`${this.baseUrl}/api/v1/rc/rc-full`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.bearerToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ id_number: payload.idNumber })
    });
    const body = await response.json().catch(() => null) as Record<string, unknown> | null;
    return { statusCode: response.status, body };
  }

  async verifyRcV2(payload: { idNumber: string; enrich?: boolean }): Promise<GstProviderResponse> {
    if (!this.bearerToken) throw new Error("SUREPASS_BEARER_TOKEN is not configured");

    const response = await this.timedFetch(`${this.baseUrl}/api/v1/rc/rc-v2`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.bearerToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ id_number: payload.idNumber, enrich: payload.enrich === true })
    });
    const body = await response.json().catch(() => null) as Record<string, unknown> | null;
    return { statusCode: response.status, body };
  }

  async matchAddresses(payload: { address1: string; address2: string }): Promise<GstProviderResponse> {
    if (!this.bearerToken) throw new Error("SUREPASS_BEARER_TOKEN is not configured");

    const response = await this.timedFetch(`${this.baseUrl}/api/v1/utils/address-matching`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.bearerToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ address_1: payload.address1, address_2: payload.address2 })
    });
    const body = await response.json().catch(() => null) as Record<string, unknown> | null;
    return { statusCode: response.status, body };
  }

  async verifyCibilScore(payload: {
    pan: string;
    mobile: string;
    name: string;
    gender: "male" | "female";
  }): Promise<GstProviderResponse> {
    if (!this.bearerToken) throw new Error("SUREPASS_BEARER_TOKEN is not configured");

    const response = await this.timedFetch(`${this.baseUrl}/api/v1/credit-report-cibil/score`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.bearerToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        pan: payload.pan,
        mobile: payload.mobile,
        name: payload.name,
        consent: "Y",
        gender: payload.gender
      })
    });
    const body = await response.json().catch(() => null) as Record<string, unknown> | null;
    return { statusCode: response.status, body };
  }

  async verifyPassportDetails(payload: { fileNumber: string; dob: string }): Promise<GstProviderResponse> {
    if (!this.bearerToken) throw new Error("SUREPASS_BEARER_TOKEN is not configured");

    const response = await this.timedFetch(`${this.baseUrl}/api/v1/passport/passport/passport-details`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.bearerToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ id_number: payload.fileNumber, dob: payload.dob })
    });
    const body = await response.json().catch(() => null) as Record<string, unknown> | null;
    return { statusCode: response.status, body };
  }

  async verifyFaceLiveness(payload: { buffer: Buffer; originalname: string; mimetype: string }): Promise<GstProviderResponse> {
    if (!this.bearerToken) throw new Error("SUREPASS_BEARER_TOKEN is not configured");
    const form = new FormData();
    const bytes = new Uint8Array(payload.buffer.length);
    bytes.set(payload.buffer);
    form.append("file", new Blob([bytes], { type: payload.mimetype || "image/jpeg" }), payload.originalname || "selfie.jpg");
    const response = await this.timedFetch(`${this.baseUrl}/api/v1/face/face-liveness`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.bearerToken}` },
      body: form
    });
    return { statusCode: response.status, body: await response.json().catch(() => null) as Record<string, unknown> | null };
  }

  async verifyFaceMatch(payload: {
    selfie: { buffer: Buffer; originalname: string; mimetype: string };
    idCard: { buffer: Buffer; originalname: string; mimetype: string };
    selfie2?: { buffer: Buffer; originalname: string; mimetype: string };
  }): Promise<GstProviderResponse> {
    if (!this.bearerToken) throw new Error("SUREPASS_BEARER_TOKEN is not configured");
    const form = new FormData();
    const appendFile = (name: string, file: { buffer: Buffer; originalname: string; mimetype: string }) => {
      const bytes = new Uint8Array(file.buffer.length);
      bytes.set(file.buffer);
      form.append(name, new Blob([bytes], { type: file.mimetype || "image/jpeg" }), file.originalname || `${name}.jpg`);
    };
    appendFile("selfie", payload.selfie);
    appendFile("id_card", payload.idCard);
    if (payload.selfie2) appendFile("selfie_2", payload.selfie2);
    const response = await this.timedFetch(`${this.baseUrl}/api/v1/face/face-match`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.bearerToken}` },
      body: form
    });
    return { statusCode: response.status, body: await response.json().catch(() => null) as Record<string, unknown> | null };
  }

  async verifyEmploymentHistory(payload: { uan: string }): Promise<GstProviderResponse> {
    if (!this.bearerToken) throw new Error("SUREPASS_BEARER_TOKEN is not configured");
    const response = await this.timedFetch(`${this.baseUrl}/api/v1/income/employment-history-uan-v2`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.bearerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ id_number: payload.uan })
    });
    return { statusCode: response.status, body: await response.json().catch(() => null) as Record<string, unknown> | null };
  }

  async verifyCurrentEmployment(payload: {
    panNumber?: string;
    mobileNumber?: string;
    uanNumber?: string;
    employerName?: string;
    employeeName?: string;
  }): Promise<GstProviderResponse> {
    if (!this.bearerToken) throw new Error("SUREPASS_BEARER_TOKEN is not configured");
    const body = {
      ...(payload.panNumber ? { pan_number: payload.panNumber } : {}),
      ...(payload.mobileNumber ? { mobile_number: payload.mobileNumber } : {}),
      ...(payload.uanNumber ? { uan_number: payload.uanNumber } : {}),
      ...(payload.employerName ? { employer_name: payload.employerName } : {}),
      ...(payload.employeeName ? { employee_name: payload.employeeName } : {})
    };
    const response = await this.timedFetch(`${this.baseUrl}/api/v1/employment/current-employment-pan-mobile`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.bearerToken}`, "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    return { statusCode: response.status, body: await response.json().catch(() => null) as Record<string, unknown> | null };
  }

  async searchEcourts(payload: { name: string; fatherName: string; address: string; year?: string; state?: string }): Promise<GstProviderResponse> {
    if (!this.bearerToken) throw new Error("SUREPASS_BEARER_TOKEN is not configured");
    const response = await this.timedFetch(`${this.baseUrl}/api/v1/ecourts/ecourt-search-v2`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.bearerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ name: payload.name, father_name: payload.fatherName, address: payload.address, year: payload.year || "", state: payload.state || "" })
    });
    return { statusCode: response.status, body: await response.json().catch(() => null) as Record<string, unknown> | null };
  }

  async getEcourtIndividualDetails(payload: { clientId: string }): Promise<GstProviderResponse> {
    if (!this.bearerToken) throw new Error("SUREPASS_BEARER_TOKEN is not configured");
    const response = await this.timedFetch(`${this.baseUrl}/api/v1/ecourts/ecourt-individual-court-details`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.bearerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ client_id: payload.clientId })
    });
    return { statusCode: response.status, body: await response.json().catch(() => null) as Record<string, unknown> | null };
  }

  async searchEcourtByCnr(payload: { cnrNumber: string; courtType: "district_court" | "high_court" }): Promise<GstProviderResponse> {
    if (!this.bearerToken) throw new Error("SUREPASS_BEARER_TOKEN is not configured");
    const response = await this.timedFetch(`${this.baseUrl}/api/v1/ecourts/ecourt-cnr-search-adv`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.bearerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ cnr_number: payload.cnrNumber, court_type: payload.courtType })
    });
    return { statusCode: response.status, body: await response.json().catch(() => null) as Record<string, unknown> | null };
  }

  async initializeAadhaarOvse(payload: AadhaarOvseInitializeData): Promise<GstProviderResponse> {
    if (!this.bearerToken) throw new Error("SUREPASS_BEARER_TOKEN is not configured");
    const response = await this.timedFetch(`${this.baseUrl}/api/v1/aadhaar-v4/initialize`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.bearerToken}`, "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    return { statusCode: response.status, body: await response.json().catch(() => null) as Record<string, unknown> | null };
  }

  async getAadhaarOvseStatus(clientId: string): Promise<GstProviderResponse> {
    if (!this.bearerToken) throw new Error("SUREPASS_BEARER_TOKEN is not configured");
    const query = new URLSearchParams({ client_id: clientId });
    const response = await this.timedFetch(`${this.baseUrl}/api/v1/aadhaar-v4/status?${query.toString()}`, {
      method: "GET",
      headers: { authorization: `Bearer ${this.bearerToken}` }
    });
    return { statusCode: response.status, body: await response.json().catch(() => null) as Record<string, unknown> | null };
  }

  async getAadhaarOvseResult(clientId: string): Promise<GstProviderResponse> {
    if (!this.bearerToken) throw new Error("SUREPASS_BEARER_TOKEN is not configured");
    const query = new URLSearchParams({ client_id: clientId });
    const response = await this.timedFetch(`${this.baseUrl}/api/v1/aadhaar-v4/result?${query.toString()}`, {
      method: "GET",
      headers: { authorization: `Bearer ${this.bearerToken}` }
    });
    return { statusCode: response.status, body: await response.json().catch(() => null) as Record<string, unknown> | null };
  }

  async initializeDigiLocker(payload: DigiLockerInitializeData): Promise<GstProviderResponse> {
    if (!this.bearerToken) throw new Error("SUREPASS_BEARER_TOKEN is not configured");
    const response = await this.timedFetch(`${this.baseUrl}/api/v1/digilocker/initialize`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.bearerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ data: payload })
    });
    return { statusCode: response.status, body: await response.json().catch(() => null) as Record<string, unknown> | null };
  }
}

