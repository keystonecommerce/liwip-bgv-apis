import type { SupplementaryCheckType } from "./supplementary-checks";
export type VerificationType = SupplementaryCheckType | "AADHAAR" | "PAN" | "DRIVING_LICENSE" | "VOTER_ID" | "ADDRESS_MATCHING" | "CURRENT_ADDRESS" | "EDUCATION" | "RC_FULL" | "RC_V2" | "CIBIL_SCORE" | "PASSPORT" | "FACE_LIVENESS" | "FACE_MATCH" | "EMPLOYMENT_HISTORY" | "CURRENT_EMPLOYMENT" | "ECOURTS_SEARCH" | "REFERENCE_CHECK" | "SKILL_CERTIFICATION";
export type VerificationStatus = "PENDING" | "QUEUED" | "PROCESSING" | "VERIFIED" | "FAILED" | "MANUAL_REVIEW";
export type ApplicationStatus = "DRAFT" | "PENDING_VERIFICATION" | "VERIFICATION_IN_PROGRESS" | "VERIFIED" | "VERIFICATION_FAILED" | "MANUAL_REVIEW";
export type FinalRecommendation = "PENDING" | "PASS" | "FAIL" | "MANUAL_REVIEW";
export type PackageCheckMode = "REQUIRED" | "OPTIONAL";
export type VerificationPackageKind = "BASE" | "ADD_ON";
export type PackageCheckExecution = "PROVIDER" | "MANUAL";
export interface ApplicationOwner {
  apiKeyId?: string;
  tenantId: string;
  clientId: string;
}

export interface ApplicationSchema {
  /** Where a check's input came from, when not typed by the worker (e.g. a signed DigiLocker document). */
  documentSources?: Partial<Record<string, { source: "DIGILOCKER"; signedBy?: string; signedAt?: string }>>;
  /** A DigiLocker session opened after Aadhaar, only to share documents for added checks. */
  digilockerDocuments?: { sessionId: string; status: "PENDING" | "COMPLETED" | "FAILED"; startedAt: string; checkedAt?: string };
  packageCode?: string;
  packageVersion?: number;
  personal: {
    phone: string;
    nameAsAadhaar: string;
    /** Full name the worker typed, as on their PAN (initials expanded). */
    declaredName?: string;
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
  /** Electricity connection the worker gave as proof of address. */
  addressProof?: { consumerNumber: string; operatorCode: string };
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
  addressConsent?: boolean;
  biometricConsent?: boolean;
  /** Consent rows the worker ticked, by id (case, identity, face, vehicle, employment, court). */
  consentItems?: string[];
  /** Checks the worker chose to run (worker self-verification). */
  selectedChecks?: string[];
  /** Opened through a partner's invite: the partner chose the package, so the checks are fixed. */
  sponsor?: { inviteId: string; partnerName: string; packageName: string };
  /** Identity the worker proved with Aadhaar. Every name-matched check compares against fullName. */
  identity?: WorkerIdentityRecord;
}

export interface WorkerIdentityRecord {
  source: "AADHAAR_OVSE" | "DIGILOCKER";
  sessionId: string;
  status: "PENDING" | "VERIFIED" | "FAILED";
  fullName?: string;
  dateOfBirth?: string;
  gender?: string;
  address?: string;
  pincode?: string;
  careOf?: string;
  verifiedAt?: string;
  /** Documents the worker also shared on DigiLocker's consent screen (types only, no numbers). */
  sharedDocuments?: Array<{ doctype: string; issuer?: string }>;
  /** Last time the provider was asked for this session's status (polling is throttled). */
  checkedAt?: string;
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
  apiKeyId?: string;
  id: string;
  tenantId: string;
  clientId: string;
  packageId?: string;
  package?: Pick<VerificationPackageRecord, "id" | "code" | "version" | "name" | "kind" | "priceInr" | "advertisedCheckCount">;
  status: ApplicationStatus;
  recommendation: FinalRecommendation;
  card?: VerificationCardRecord;
  data: ApplicationSchema;
  /** Opened by the worker themselves (worker app), not submitted by a partner. */
  workerCase?: boolean;
  verificationIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface VerificationCardRecord {
  id: string;
  applicationId: string;
  cardNumber: string;
  publicId: string;
  status: "ACTIVE" | "SUSPENDED" | "EXPIRED";
  issuedAt: string;
  expiresAt: string;
}

export interface VerificationJob {
  verificationId: string;
  applicationId: string;
  type: VerificationType;
  /** Set when the worker submitted new input: calls from attempts up to this one are settled history, not an unknown outcome to reconcile. */
  inputAfterAttempt?: number;
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

