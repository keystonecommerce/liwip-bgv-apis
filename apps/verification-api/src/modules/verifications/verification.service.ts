import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { ApplicationOwner, ApplicationSchema, PackageCheckRule, SensitiveVerificationInputs, VerificationType } from "../../domain/verification.types";
import { VerificationQueue } from "./verification.queue";
import { VerificationStore } from "./verification.repository";
import { isSupplementaryCheck } from "../../domain/supplementary-checks";

function hasValue(value: unknown): boolean { return value !== undefined && value !== null && value !== ""; }

const checkNames: Partial<Record<VerificationType, string>> = {
  AADHAAR: "e-Aadhaar PDF or Aadhaar reference",
  PAN: "PAN number",
  DRIVING_LICENSE: "driving licence number and date of birth",
  VOTER_ID: "Voter ID / EPIC number",
  ADDRESS_MATCHING: "submitted address and a verified Aadhaar address",
  CURRENT_ADDRESS: "current residential address",
  EDUCATION: "education details",
  RC_FULL: "vehicle registration number",
  RC_V2: "vehicle registration number",
  CIBIL_SCORE: "PAN, mobile, name, gender and credit consent",
  PASSPORT: "passport file number and date of birth",
  FACE_LIVENESS: "selfie and biometric consent",
  FACE_MATCH: "selfie, ID card and biometric consent",
  EMPLOYMENT_HISTORY: "12-digit UAN",
  CURRENT_EMPLOYMENT: "PAN, mobile number or 12-digit UAN",
  ECOURTS_SEARCH: "name, father name, submitted address and court-search consent",
  REFERENCE_CHECK: "reference name and contact details",
  SKILL_CERTIFICATION: "skill or certification details"
};

@Injectable()
export class VerificationService {
  constructor(
    @Inject(VerificationStore) private readonly store: VerificationStore,
    @Inject(VerificationQueue) private readonly queue: VerificationQueue
  ) {}

  async createApplication(data: ApplicationSchema, sensitiveInputs?: SensitiveVerificationInputs, requestedOwner?: ApplicationOwner) {
    if (data.consent?.granted !== true) {
      throw new BadRequestException("Worker consent is required before verification jobs can be created");
    }
    const packageCode = data.packageCode || "BASIC_ID";
    const owner = requestedOwner || await this.store.getWorkerPortalOwner();
    const verificationPackage = await this.store.getPackageByCode(packageCode, data.packageVersion, owner.tenantId);
    if (!verificationPackage || !verificationPackage.isActive) {
      throw new BadRequestException(`Verification package ${packageCode}${data.packageVersion ? ` v${data.packageVersion}` : ""} was not found or is inactive`);
    }
    if (verificationPackage.kind !== "BASE") {
      throw new BadRequestException(`${verificationPackage.code} is an add-on and cannot be used as the primary worker package`);
    }

    const normalizedData: ApplicationSchema = {
      ...data,
      packageCode: verificationPackage.code,
      packageVersion: verificationPackage.version
    };
    const types = this.determineVerificationTypes(normalizedData, verificationPackage.checks);
    const application = await this.store.createApplication(normalizedData, types, verificationPackage, owner);
    if (sensitiveInputs) this.store.setSensitiveInputs(application.id, sensitiveInputs);
    let hasManualCheck = false;
    for (const verificationId of application.verificationIds) {
      const verification = await this.store.getVerification(verificationId);
      if (!verification) continue;
      const rule = verificationPackage.checks.find((item) => item.type === verification.type);
      if (rule?.execution === "MANUAL") {
        hasManualCheck = true;
        await this.store.setResult(verification.id, "MANUAL_REVIEW", {
          result: {
            reason: "This package checkpoint requires an authorised reviewer.",
            source: "package-rule",
            packageCode: verificationPackage.code
          }
        });
        continue;
      }
      if (verification.type === "ADDRESS_MATCHING") continue;
      await this.queue.addVerificationJob({ verificationId, applicationId: application.id, type: verification.type });
    }
    if (hasManualCheck) await this.store.recalculateApplicationStatus(application.id, owner);
    return this.getApplicationDetails(application.id, owner);
  }

  async getApplicationDetails(id: string, owner?: ApplicationOwner) {
    const application = await this.store.getApplication(id, owner);
    if (!application) throw new NotFoundException(`Application ${id} not found`);
    return { ...application, verifications: await this.store.getVerificationsForApplication(id, owner) };
  }

  async retryVerification(id: string, owner?: ApplicationOwner) {
    const verification = await this.store.getVerification(id, owner);
    if (!verification) throw new NotFoundException(`Verification ${id} not found`);
    if (isSupplementaryCheck(verification.type)) throw new BadRequestException("Supplementary checks must be resubmitted with a new Idempotency-Key after reviewing the previous outcome");
    if (verification.status !== "FAILED") throw new BadRequestException("Only failed checks can be retried; pending/reviewed checks require case review");
    const application = await this.store.getApplication(verification.applicationId, owner);
    if (!application) throw new NotFoundException("Application not found");
    if (await this.store.hasDispatchedCall(verification.id, application)) throw new BadRequestException("Previously dispatched provider work requires reconciliation; create a new check for a deliberate recheck");
    await this.queue.addVerificationJob({ verificationId: verification.id, applicationId: verification.applicationId, type: verification.type });
    return this.getApplicationDetails(verification.applicationId, owner);
  }

  async reviewVerification(
    id: string,
    input: { decision?: string; note?: string },
    owner: ApplicationOwner
  ) {
    const verification = await this.store.getVerification(id, owner);
    if (!verification) throw new NotFoundException(`Verification ${id} not found`);
    if (verification.status !== "MANUAL_REVIEW") {
      throw new BadRequestException("Only a manual-review checkpoint can receive a review decision");
    }
    const decision = String(input?.decision || "").trim().toUpperCase();
    if (decision !== "VERIFIED" && decision !== "FAILED") {
      throw new BadRequestException("decision must be VERIFIED or FAILED");
    }
    const note = String(input?.note || "").trim();
    if (note.length < 3 || note.length > 500) {
      throw new BadRequestException("note must contain between 3 and 500 characters");
    }
    await this.store.setResult(verification.id, decision, {
      result: {
        ...(verification.result || {}),
        reviewDecision: decision,
        reviewNote: note,
        reviewedAt: new Date().toISOString(),
        reviewedByClientId: owner.clientId
      },
      failureCode: decision === "FAILED" ? "MANUAL_REVIEW_REJECTED" : undefined,
      failureReason: decision === "FAILED" ? note : undefined
    }, owner);
    await this.store.recalculateApplicationStatus(verification.applicationId, owner);
    return this.getApplicationDetails(verification.applicationId, owner);
  }

  listPackages() {
    return this.store.listActivePackages();
  }

  private determineVerificationTypes(data: ApplicationSchema, rules: PackageCheckRule[]): VerificationType[] {
    const requiredMissing = rules
      .filter((rule) => rule.mode === "REQUIRED" && !this.isCheckReady(rule.type, data))
      .map((rule) => `${rule.type}: ${checkNames[rule.type]}`);
    if (requiredMissing.length) {
      throw new BadRequestException(`Missing inputs for selected package: ${requiredMissing.join("; ")}`);
    }

    return rules
      .filter((rule) => this.isCheckReady(rule.type, data))
      .map((rule) => rule.type)
      .filter((type, index, all) => all.indexOf(type) === index);
  }

  private isCheckReady(type: VerificationType, data: ApplicationSchema): boolean {
    const documents = data.documents || {};
    const personal = data.personal || {};
    const education = data.education || {};
    const hasAadhaar = hasValue(personal.aadhaarReference) || hasValue(documents.aadhaarFront) || hasValue(documents.aadhaarBack) || hasValue(documents.aadhaarPdf);

    if (type === "AADHAAR") return hasAadhaar;
    if (type === "PAN") return hasValue(personal.panNumber);
    if (type === "DRIVING_LICENSE") return hasValue(personal.drivingLicenceNumber) && hasValue(personal.drivingLicenceDob || personal.dateOfBirth);
    if (type === "VOTER_ID") return hasValue(personal.voterId) && hasValue(personal.nameAsAadhaar) && hasValue(personal.dateOfBirth);
    if (type === "ADDRESS_MATCHING") return hasValue(personal.submittedAddress) && hasAadhaar;
    if (type === "CURRENT_ADDRESS") return hasValue(personal.submittedAddress);
    if (type === "EDUCATION") return hasValue(education.highestQualification) || hasValue(education.courseName);
    if (type === "RC_FULL" || type === "RC_V2") return hasValue(data.vehicle?.registrationNumber);
    if (type === "CIBIL_SCORE") return hasValue(personal.panNumber) && hasValue(personal.phone) && hasValue(personal.nameAsAadhaar) && hasValue(personal.gender) && data.creditConsent?.granted === true;
    if (type === "PASSPORT") return hasValue(personal.passportFileNumber) && hasValue(personal.dateOfBirth);
    if (type === "FACE_LIVENESS") return hasValue(documents.selfie) && data.biometricConsent === true;
    if (type === "FACE_MATCH") return hasValue(documents.selfie) && hasValue(documents.idCard) && data.biometricConsent === true;
    if (type === "EMPLOYMENT_HISTORY") return hasValue(data.employment?.uan);
    if (type === "CURRENT_EMPLOYMENT") return hasValue(personal.panNumber) || hasValue(personal.phone) || hasValue(data.employment?.uan);
    if (type === "ECOURTS_SEARCH") return hasValue(personal.nameAsAadhaar) && hasValue(data.criminal?.fatherName) && data.criminal?.consent === true && hasValue(personal.submittedAddress);
    if (type === "REFERENCE_CHECK") return Array.isArray(data.references) && data.references.some((item) => hasValue(item.name) && hasValue(item.phone));
    if (type === "SKILL_CERTIFICATION") return hasValue(data.skills?.certificationName) || hasValue(data.skills?.certificateReference);
    return false;
  }
}

