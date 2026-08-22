import { randomUUID } from "node:crypto";
import { ApplicationRecord, ApplicationSchema, ApplicationStatus, SensitiveVerificationInputs, VerificationRecord, VerificationStatus, VerificationTestOptions, VerificationType } from "../types";

export class VerificationStore {
  private readonly applications = new Map<string, ApplicationRecord>();
  private readonly verifications = new Map<string, VerificationRecord>();
  private readonly sensitiveInputs = new Map<string, SensitiveVerificationInputs>();

  createApplication(data: ApplicationSchema, types: VerificationType[], testOptions?: VerificationTestOptions): ApplicationRecord {
    const now = new Date().toISOString();
    const applicationId = `app_${randomUUID()}`;
    const verificationIds: string[] = [];

    for (const type of types) {
      const id = `verification_${randomUUID()}`;
      verificationIds.push(id);
      this.verifications.set(id, {
        id,
        applicationId,
        type,
        status: "QUEUED",
        provider: testOptions?.provider || process.env.VERIFICATION_PROVIDER || "mock",
        attemptCount: 0,
        createdAt: now,
        updatedAt: now
      });
    }

    const application: ApplicationRecord = {
      id: applicationId,
      status: types.length ? "PENDING_VERIFICATION" : "VERIFIED",
      data,
      verificationIds,
      createdAt: now,
      updatedAt: now,
      testOptions
    };
    this.applications.set(applicationId, application);
    return application;
  }

  getApplication(id: string) { return this.applications.get(id); }
  getVerification(id: string) { return this.verifications.get(id); }
  getVerificationsForApplication(applicationId: string) { return [...this.verifications.values()].filter((item) => item.applicationId === applicationId); }
  setSensitiveInputs(applicationId: string, inputs: SensitiveVerificationInputs) { this.sensitiveInputs.set(applicationId, inputs); }
  getSensitiveInputs(applicationId: string) { return this.sensitiveInputs.get(applicationId); }
  clearSensitiveInputs(applicationId: string) { this.sensitiveInputs.delete(applicationId); }

  updateVerification(id: string, patch: Partial<VerificationRecord>): VerificationRecord {
    const current = this.verifications.get(id);
    if (!current) throw new Error(`Verification ${id} not found`);
    const updated = { ...current, ...patch, updatedAt: new Date().toISOString() };
    this.verifications.set(id, updated);
    return updated;
  }

  updateApplicationStatus(applicationId: string, status: ApplicationStatus): ApplicationRecord {
    const current = this.applications.get(applicationId);
    if (!current) throw new Error(`Application ${applicationId} not found`);
    const updated = { ...current, status, updatedAt: new Date().toISOString() };
    this.applications.set(applicationId, updated);
    return updated;
  }

  recalculateApplicationStatus(applicationId: string): ApplicationRecord {
    const application = this.applications.get(applicationId);
    if (!application) throw new Error(`Application ${applicationId} not found`);
    const checks = this.getVerificationsForApplication(applicationId);
    const statuses = checks.map((check) => check.status);
    let status: ApplicationStatus = "VERIFICATION_IN_PROGRESS";

    if (statuses.some((value) => value === "MANUAL_REVIEW")) status = "MANUAL_REVIEW";
    else if (statuses.some((value) => value === "FAILED")) status = "VERIFICATION_FAILED";
    else if (checks.length > 0 && statuses.every((value) => value === "VERIFIED")) status = "VERIFIED";
    else if (statuses.every((value) => value === "QUEUED" || value === "PENDING")) status = "PENDING_VERIFICATION";

    return this.updateApplicationStatus(applicationId, status);
  }

  setProcessing(id: string) { return this.updateVerification(id, { status: "PROCESSING", startedAt: new Date().toISOString() }); }

  setResult(id: string, status: VerificationStatus, patch: Partial<VerificationRecord> = {}) {
    return this.updateVerification(id, { status, completedAt: new Date().toISOString(), ...patch });
  }
}
