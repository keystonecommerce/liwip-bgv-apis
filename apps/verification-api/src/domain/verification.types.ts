export type VerificationType = "AADHAAR" | "PAN" | "DRIVING_LICENSE" | "VOTER_ID" | "ADDRESS_MATCHING" | "CURRENT_ADDRESS" | "EDUCATION" | "RC_FULL" | "RC_V2" | "CIBIL_SCORE" | "PASSPORT" | "FACE_LIVENESS" | "FACE_MATCH" | "EMPLOYMENT_HISTORY" | "CURRENT_EMPLOYMENT" | "ECOURTS_SEARCH" | "REFERENCE_CHECK" | "SKILL_CERTIFICATION";
export type VerificationStatus = "PENDING" | "QUEUED" | "PROCESSING" | "VERIFIED" | "FAILED" | "MANUAL_REVIEW";
export type ApplicationStatus = "PENDING_VERIFICATION" | "VERIFICATION_IN_PROGRESS" | "VERIFIED" | "VERIFICATION_FAILED" | "MANUAL_REVIEW";
export type PackageCheckMode = "REQUIRED" | "OPTIONAL";
export type VerificationPackageKind = "BASE" | "ADD_ON";
export type PackageCheckExecution = "PROVIDER" | "MANUAL";
export interface ApplicationOwner {
  tenantId: string;
  clientId: string;
}

export interface ApplicationSchema {
  packageCode?: string;
  packageVersion?: number;
  personal: {
    phone: string;
    nameAsAadhaar: string;
    alternatePhone?: string;
    email?: string;
    dateOfBirth: string;
    gender?: string;
    aadhaarReference?: string;
    panNumber?: string;
    voterId?: string;
    fatherName?: string;
    drivingLicenceNumber?: string;
    drivingLicenceDob?: string;
    passportFileNumber?: string;
    submittedAddress?: string;
  };
  permanentAddress?: Record<string, unknown>;
  currentLocation?: Record<string, unknown>;
  employment?: Record<string, unknown>;
  references?: Array<{ name: string; phone?: string; relationship?: string }>;
  skills?: { certificationName?: string; certificateReference?: string };
  criminal?: { fatherName?: string; year?: string; state?: string; consent?: boolean };
  education?: { highestQualification?: string; courseName?: string };
  jobPreferences?: Record<string, unknown>;
  vehicle?: { registrationNumber?: string; [key: string]: unknown };
  languages?: Record<string, unknown>;
  jobReadiness?: Record<string, unknown>;
  documents?: {
    profilePhoto?: unknown;
    aadhaarFront?: unknown;
    aadhaarBack?: unknown;
    aadhaarPdf?: { fileName: string };
    drivingLicence?: unknown;
    panCard?: unknown;
    bankProof?: unknown;
    vehicleRc?: unknown;
    vehicleInsurance?: unknown;
    selfie?: { fileName: string };
    idCard?: { fileName: string };
  };
  consent?: {
    granted: boolean;
    purpose: string;
    textVersion: string;
    grantedAt: string;
  };
  creditConsent?: {
    granted: boolean;
    purpose: string;
    textVersion: string;
    grantedAt: string;
  };
}

export interface PackageCheckRule {
  type: VerificationType;
  mode: PackageCheckMode;
  execution?: PackageCheckExecution;
}

export interface VerificationPackageRecord {
  id: string;
  code: string;
  version: number;
  name: string;
  description?: string;
  kind: VerificationPackageKind;
  priceInr?: number;
  advertisedCheckCount?: number;
  targetWorkforce?: string;
  displayOrder: number;
  isActive: boolean;
  checks: PackageCheckRule[];
  createdAt: string;
  updatedAt: string;
}

export interface VerificationRecord {
  id: string;
  applicationId: string;
  type: VerificationType;
  status: VerificationStatus;
  provider: string;
  attemptCount: number;
  providerRequestId?: string;
  result?: Record<string, unknown>;
  failureResponse?: Record<string, unknown> | null;
  failureCode?: string;
  failureReason?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  updatedAt: string;
}

export interface ApplicationRecord {
  id: string;
  tenantId: string;
  clientId: string;
  packageId?: string;
  package?: Pick<VerificationPackageRecord, "id" | "code" | "version" | "name" | "kind" | "priceInr" | "advertisedCheckCount">;
  status: ApplicationStatus;
  data: ApplicationSchema;
  verificationIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface VerificationJob {
  verificationId: string;
  applicationId: string;
  type: VerificationType;
}

export interface SensitiveVerificationInputs {
  aadhaarPdf?: {
    buffer: Buffer;
    originalname: string;
    mimetype: string;
    fullName: string;
    yearOfBirth: string;
  };
  selfie?: {
    buffer: Buffer;
    originalname: string;
    mimetype: string;
  };
  idCard?: {
    buffer: Buffer;
    originalname: string;
    mimetype: string;
  };
}
