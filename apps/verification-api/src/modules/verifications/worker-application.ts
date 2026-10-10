import { BadRequestException } from "@nestjs/common";
import type { ApplicationSchema, SensitiveVerificationInputs } from "../../domain/verification.types";

export interface WorkerUploadFile {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
}

export interface WorkerVerificationPayload {
  package_code?: string;
  name?: string;
  dob?: string;
  mobile?: string;
  pan?: string;
  driving_license?: string;
  driving_license_dob?: string;
  voter_id?: string;
  father_name?: string;
  uan?: string;
  employer_name?: string;
  reference_name?: string;
  reference_phone?: string;
  reference_relationship?: string;
  skill_certification?: string;
  certificate_reference?: string;
  criminal_consent?: string;
  criminal_year?: string;
  criminal_state?: string;
  gender?: string;
  vehicle_registration_number?: string;
  passport_file_number?: string;
  credit_consent?: string;
  submitted_address?: string;
  consent?: string;
  address_consent?: string;
  biometric_consent?: string;
}

export function buildWorkerApplication(
  payload: WorkerVerificationPayload,
  files?: Record<string, WorkerUploadFile[]>
): { data: ApplicationSchema; sensitiveInputs?: SensitiveVerificationInputs } {
  const aadhaar = files?.aadhaar_file?.[0];
  const selfie = files?.selfie?.[0];
  const idCard = files?.id_card?.[0];
  if ([payload?.name, payload?.dob, payload?.mobile].some((value) => !String(value || "").trim())) {
    throw new BadRequestException("name, dob, and mobile are required");
  }
  if (aadhaar?.buffer && !aadhaar.originalname?.toLowerCase().endsWith(".pdf") && aadhaar.mimetype !== "application/pdf") {
    throw new BadRequestException("The Aadhaar document must be a PDF");
  }
  if ((selfie || idCard) && (!selfie || !idCard)) {
    throw new BadRequestException("Upload both a selfie and an ID card for face verification");
  }
  if ((selfie || idCard) && payload.biometric_consent !== "Y") {
    throw new BadRequestException("Biometric consent is required for face verification");
  }
  if (payload.uan && !/^\d{12}$/.test(payload.uan)) throw new BadRequestException("uan must be a 12-digit number");
  if (payload.criminal_consent === "Y" && (!payload.father_name?.trim() || !payload.submitted_address?.trim())) {
    throw new BadRequestException("father_name and submitted_address are required for the court-record check");
  }
  if (payload.consent !== "Y") throw new BadRequestException("Identity verification consent is required");
  if ((payload.submitted_address || aadhaar) && payload.address_consent !== "Y") {
    throw new BadRequestException("Address consent is required when an address or Aadhaar document is submitted");
  }
  if (payload.pan && !/^[A-Za-z]{5}[0-9]{4}[A-Za-z]$/.test(payload.pan)) {
    throw new BadRequestException("pan must match the format ABCDE1234F");
  }
  if (!/^\d{10}$/.test(payload.mobile!)) throw new BadRequestException("mobile must be a 10-digit number");
  if (payload.gender && !["male", "female"].includes(payload.gender)) {
    throw new BadRequestException("gender must be male or female");
  }
  if (payload.credit_consent === "Y" && !payload.gender) {
    throw new BadRequestException("gender is required for a CIBIL check");
  }

  const data: ApplicationSchema = {
    packageCode: payload.package_code?.trim().toUpperCase() || "BASIC_ID",
    personal: {
      phone: payload.mobile!,
      nameAsAadhaar: payload.name!.trim(),
      dateOfBirth: payload.dob!,
      panNumber: payload.pan?.trim().toUpperCase() || undefined,
      drivingLicenceNumber: payload.driving_license?.trim() || undefined,
      drivingLicenceDob: payload.driving_license ? payload.driving_license_dob || payload.dob : undefined,
      voterId: payload.voter_id?.trim() || undefined,
      gender: payload.gender || undefined,
      passportFileNumber: payload.passport_file_number?.trim() || undefined,
      submittedAddress: payload.submitted_address?.trim() || undefined
    },
    employment: payload.uan || payload.employer_name?.trim() ? {
      uan: payload.uan?.trim() || undefined,
      employerName: payload.employer_name?.trim() || undefined
    } : undefined,
    references: payload.reference_name?.trim() ? [{
      name: payload.reference_name.trim(),
      phone: payload.reference_phone?.trim() || undefined,
      relationship: payload.reference_relationship?.trim() || undefined
    }] : undefined,
    skills: payload.skill_certification?.trim() || payload.certificate_reference?.trim() ? {
      certificationName: payload.skill_certification?.trim() || undefined,
      certificateReference: payload.certificate_reference?.trim() || undefined
    } : undefined,
    criminal: payload.criminal_consent === "Y" ? {
      fatherName: payload.father_name?.trim(),
      year: payload.criminal_year?.trim() || undefined,
      state: payload.criminal_state?.trim() || undefined,
      consent: true
    } : undefined,
    vehicle: payload.vehicle_registration_number?.trim()
      ? { registrationNumber: payload.vehicle_registration_number.trim().toUpperCase() }
      : undefined,
    documents: aadhaar?.buffer || selfie?.buffer || idCard?.buffer ? {
      ...(aadhaar?.buffer ? { aadhaarPdf: { fileName: aadhaar.originalname } } : {}),
      ...(selfie?.buffer ? { selfie: { fileName: selfie.originalname } } : {}),
      ...(idCard?.buffer ? { idCard: { fileName: idCard.originalname } } : {})
    } : undefined,
    consent: {
      granted: true,
      purpose: "Gig-worker identity and address verification",
      textVersion: "worker-verification-v1",
      grantedAt: new Date().toISOString()
    },
    addressConsent: payload.address_consent === "Y",
    biometricConsent: payload.biometric_consent === "Y",
    ...(payload.credit_consent === "Y" ? {
      creditConsent: {
        granted: true,
        purpose: "CIBIL credit-score verification",
        textVersion: "worker-credit-verification-v1",
        grantedAt: new Date().toISOString()
      }
    } : {})
  };

  const sensitiveInputs = aadhaar?.buffer || selfie?.buffer || idCard?.buffer ? {
    ...(aadhaar?.buffer ? { aadhaarPdf: {
      buffer: aadhaar.buffer,
      originalname: aadhaar.originalname,
      mimetype: aadhaar.mimetype,
      fullName: payload.name!.trim(),
      yearOfBirth: payload.dob!.slice(0, 4)
    } } : {}),
    ...(selfie?.buffer ? { selfie: { buffer: selfie.buffer, originalname: selfie.originalname, mimetype: selfie.mimetype } } : {}),
    ...(idCard?.buffer ? { idCard: { buffer: idCard.buffer, originalname: idCard.originalname, mimetype: idCard.mimetype } } : {})
  } satisfies SensitiveVerificationInputs : undefined;

  return { data, sensitiveInputs };
}
