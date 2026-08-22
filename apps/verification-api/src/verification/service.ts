import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { ApplicationSchema, SensitiveVerificationInputs, VerificationTestOptions, VerificationType } from "../types";
import { VerificationQueue } from "./queue";
import { VerificationStore } from "./store";

function hasValue(value: unknown): boolean { return value !== undefined && value !== null && value !== ""; }

@Injectable()
export class VerificationService {
  constructor(
    @Inject(VerificationStore) private readonly store: VerificationStore,
    @Inject(VerificationQueue) private readonly queue: VerificationQueue
  ) {}

  async createApplication(data: ApplicationSchema, testOptions?: VerificationTestOptions, sensitiveInputs?: SensitiveVerificationInputs) {
    const types = this.determineVerificationTypes(data);
    const application = this.store.createApplication(data, types, testOptions);
    if (sensitiveInputs) this.store.setSensitiveInputs(application.id, sensitiveInputs);
    for (const verificationId of application.verificationIds) {
      const verification = this.store.getVerification(verificationId);
      if (!verification) continue;
      if (verification.type === "ADDRESS_MATCHING") continue;
      await this.queue.addVerificationJob({ verificationId, applicationId: application.id, type: verification.type, testOptions });
    }
    return this.getApplicationDetails(application.id);
  }

  getApplicationDetails(id: string) {
    const application = this.store.getApplication(id);
    if (!application) throw new NotFoundException(`Application ${id} not found`);
    return { ...application, verifications: this.store.getVerificationsForApplication(id) };
  }

  async retryVerification(id: string) {
    const verification = this.store.getVerification(id);
    if (!verification) throw new NotFoundException(`Verification ${id} not found`);
    await this.queue.addVerificationJob({ verificationId: verification.id, applicationId: verification.applicationId, type: verification.type, testOptions: this.store.getApplication(verification.applicationId)?.testOptions });
    return this.getApplicationDetails(verification.applicationId);
  }

  private determineVerificationTypes(data: ApplicationSchema) {
    const types: VerificationType[] = [];
    const documents = data.documents || {};
    const personal = data.personal || {};
    const education = data.education || {};
    if (hasValue(personal.aadhaarReference) || hasValue(documents.aadhaarFront) || hasValue(documents.aadhaarBack) || hasValue(documents.aadhaarPdf)) types.push("AADHAAR");
    if (hasValue(personal.panNumber) || hasValue(documents.panCard)) types.push("PAN");
    if (hasValue(personal.drivingLicenceNumber) || hasValue(documents.drivingLicence)) types.push("DRIVING_LICENSE");
    if (hasValue(personal.voterId)) types.push("VOTER_ID");
    // Address Matching needs an official address source. In the worker flow that
    // source is the e-Aadhaar result, so do not create a job when Aadhaar is skipped.
    if (hasValue(personal.submittedAddress) && types.includes("AADHAAR")) types.push("ADDRESS_MATCHING");
    if (hasValue(education.highestQualification) || hasValue(education.courseName)) types.push("EDUCATION");
    if (hasValue(data.vehicle?.registrationNumber)) types.push("RC_V2");
    if (hasValue(personal.passportFileNumber)) types.push("PASSPORT");
    if (hasValue(personal.gender) && data.creditConsent?.granted === true) types.push("CIBIL_SCORE");
    if (hasValue(documents.selfie) && hasValue(documents.idCard)) {
      types.push("FACE_LIVENESS", "FACE_MATCH");
    }
    if (hasValue(data.employment?.uan)) types.push("EMPLOYMENT_HISTORY");
    if (hasValue(data.criminal?.fatherName) && data.criminal?.consent === true && hasValue(personal.submittedAddress)) {
      types.push("ECOURTS_SEARCH");
    }
    return types;
  }
}
