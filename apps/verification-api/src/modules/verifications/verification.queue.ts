import { providerCallContext } from "../usage/provider-call.context";
import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Job, Queue, Worker } from "bullmq";
import IORedis from "ioredis";
import { SensitiveVerificationInputs, VerificationJob, VerificationType } from "../../domain/verification.types";
import { VERIFICATION_PROVIDER, VerificationProvider } from "../../integrations/verification-provider";
import { VerificationStore } from "./verification.repository";

const connectionOptions = {
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: Number(process.env.REDIS_PORT || 6380),
  maxRetriesPerRequest: null as null
};

// Stable namespace for the BGV verification queue.
const queueName = "application-verification";
const queuePrefix = "gig-verification-v1";

function formatAddress(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  return Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined && item !== null && item !== "")
    .map(([key, item]) => `${key}: ${String(item)}`)
    .join(", ");
}

function applicationToPayload(
  type: VerificationType,
  data: Record<string, any>,
  sensitiveInputs?: SensitiveVerificationInputs,
  officialAddress?: string
): Record<string, unknown> {
  const personal = data.personal || {};
  const education = data.education || {};
  const vehicle = data.vehicle || {};
  if (type === "AADHAAR" && sensitiveInputs?.aadhaarPdf) return sensitiveInputs.aadhaarPdf as unknown as Record<string, unknown>;
  if (type === "AADHAAR") return { name: personal.nameAsAadhaar, dateOfBirth: personal.dateOfBirth, aadhaarReference: personal.aadhaarReference };
  if (type === "PAN") return { idNumber: personal.panNumber, name: personal.nameAsAadhaar };
  if (type === "DRIVING_LICENSE") return { licenseNumber: personal.drivingLicenceNumber, name: personal.nameAsAadhaar, dob: personal.drivingLicenceDob || personal.dateOfBirth };
  if (type === "VOTER_ID") return { idNumber: personal.voterId, fullName: personal.nameAsAadhaar, dob: personal.dateOfBirth };
  if (type === "ADDRESS_MATCHING") return { address1: personal.submittedAddress, address2: officialAddress };
  if (type === "RC_FULL") return { idNumber: vehicle.registrationNumber };
  if (type === "RC_V2") return { idNumber: vehicle.registrationNumber };
  if (type === "CIBIL_SCORE") return { pan: personal.panNumber, mobile: personal.phone, name: personal.nameAsAadhaar, gender: personal.gender };
  if (type === "PASSPORT") return { fileNumber: personal.passportFileNumber, dob: personal.dateOfBirth, name: personal.nameAsAadhaar };
  if (type === "FACE_LIVENESS" && sensitiveInputs?.selfie) return sensitiveInputs.selfie as unknown as Record<string, unknown>;
  if (type === "FACE_MATCH" && sensitiveInputs?.selfie && sensitiveInputs?.idCard) {
    return { selfie: sensitiveInputs.selfie, idCard: sensitiveInputs.idCard } as unknown as Record<string, unknown>;
  }
  if (type === "EMPLOYMENT_HISTORY") return { uan: data.employment?.uan };
  if (type === "CURRENT_EMPLOYMENT") return {
    panNumber: personal.panNumber,
    mobileNumber: personal.phone,
    uanNumber: data.employment?.uan,
    employerName: data.employment?.employerName,
    employeeName: personal.nameAsAadhaar
  };
  if (type === "ECOURTS_SEARCH") return {
    name: personal.nameAsAadhaar,
    fatherName: data.criminal?.fatherName,
    address: personal.submittedAddress,
    year: data.criminal?.year,
    state: data.criminal?.state
  };
  return { name: personal.nameAsAadhaar, qualification: education.highestQualification, courseName: education.courseName };
}

@Injectable()
export class VerificationQueue implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(VerificationQueue.name);
  private readonly connection = new IORedis(connectionOptions);
  private readonly queue = new Queue<VerificationJob>(queueName, {
    connection: this.connection,
    prefix: queuePrefix
  });
  private worker?: Worker<VerificationJob>;

  constructor(
    @Inject(VerificationStore) private readonly store: VerificationStore,
    @Inject(VERIFICATION_PROVIDER) private readonly provider: VerificationProvider
  ) {}

  // Purge the in-memory raw PII buffers (Aadhaar PDF, selfie, ID card) once no
  // check for the application is still pending, so sensitive data isn't retained
  // in the process heap (and the map can't grow unbounded).
  private async purgeSensitiveInputsIfDone(applicationId: string): Promise<void> {
    const verifications = await this.store.getVerificationsForApplication(applicationId);
    const stillPending = verifications.some((v) => ["PENDING", "QUEUED", "PROCESSING"].includes(v.status));
    if (!stillPending) this.store.clearSensitiveInputs(applicationId);
  }

  async onModuleInit(): Promise<void> {
    this.worker = new Worker<VerificationJob>(queueName, async (job) => this.process(job), {
      connection: this.connection,
      prefix: queuePrefix,
      concurrency: 5
    });

    this.worker.on("failed", (job, error) => {
      void this.handleFailedJob(job, error).catch((handlerError) => {
        this.logger.error("Could not persist a failed verification job", handlerError);
      });
    });
  }

  async addVerificationJob(job: VerificationJob): Promise<void> {
    // A completed/failed job is retained (removeOnComplete/Fail: 100), and
    // BullMQ treats add() with an existing jobId as a no-op — so a retry would
    // silently do nothing. Drop any prior job for this verification first.
    // (No-op on first enqueue; ignored if the job is currently active.)
    await this.queue.remove(`verification-${job.verificationId}`).catch(() => undefined);
    await this.queue.add(`verify.${job.type.toLowerCase()}`, job, {
      jobId: `verification-${job.verificationId}`,
      attempts: 5,
      backoff: { type: "exponential", delay: 5000 },
      removeOnComplete: 100,
      removeOnFail: 100
    });
  }

  private async process(job: Job<VerificationJob>): Promise<void> {
    const verification = await this.store.getVerification(job.data.verificationId);
    const application = await this.store.getApplication(job.data.applicationId);
    if (!verification || !application || verification.applicationId !== application.id || verification.type !== job.data.type) throw new Error("Verification job ownership mismatch");
    const owner = { tenantId: application.tenantId, clientId: application.clientId };
    if (["VERIFIED", "MANUAL_REVIEW", "PENDING"].includes(verification.status)) return;
    if (await this.store.hasDispatchedCall(verification.id, owner)) {
      await this.store.setResult(verification.id, "MANUAL_REVIEW", { failureCode: "PROVIDER_OUTCOME_UNKNOWN", failureReason: "A dispatched provider call requires reconciliation before retrying" }, owner);
      await this.store.recalculateApplicationStatus(application.id, owner);
      return;
    }
    if (!await this.store.claimForProcessing(verification.id, owner, verification.attemptCount)) return;

    const applicationVerifications = await this.store.getVerificationsForApplication(application.id);
    const aadhaarVerification = applicationVerifications.find((item) => item.type === "AADHAAR");
    const officialAddress = formatAddress(aadhaarVerification?.result?.address || aadhaarVerification?.result?.permanent_address);
    const response = await providerCallContext.run({ ...owner, apiKeyId: application.apiKeyId, applicationId: application.id, verificationId: verification.id, operationKey: `verification_${verification.id}_attempt_${verification.attemptCount + 1}` }, () => this.provider.verify(
      verification.type,
      applicationToPayload(verification.type, application.data as Record<string, any>, this.store.getSensitiveInputs(application.id), officialAddress)
    ));

    if (response.status === "verified") {
      await this.store.setResult(verification.id, "VERIFIED", { providerRequestId: response.requestId, result: response.data || {} }, owner);
      // Provider did the work and it passed → billable.
      if (verification.type === "AADHAAR") await this.queueAddressMatch(application.id);
    } else if (response.status === "manual_review") {
      await this.store.setResult(verification.id, "MANUAL_REVIEW", { providerRequestId: response.requestId, result: response.data || {} }, owner);
      // Provider did the work; needs a human → still billable.
    } else if (response.status === "pending") {
      await this.store.updateVerification(verification.id, { status: "PENDING", providerRequestId: response.requestId, result: response.data || undefined }, owner);
      // Provider-call accounting is already durable; verification remains pending.
    } else {
      await this.store.setResult(verification.id, "FAILED", {
        providerRequestId: response.requestId,
        result: response.data || {},
        failureCode: "VERIFICATION_FAILED",
        failureReason: "Provider returned a failed verification result"
      }, owner);
      // Provider responded with a negative result (e.g. record not found / no
      // match). The lookup still happened → billable.
    }
    await this.store.recalculateApplicationStatus(application.id, owner);
    await this.purgeSensitiveInputsIfDone(application.id);
  }

  private async queueAddressMatch(applicationId: string): Promise<void> {
    const verifications = await this.store.getVerificationsForApplication(applicationId);
    const addressVerification = verifications.find((item) => item.type === "ADDRESS_MATCHING");
    if (!addressVerification || addressVerification.status !== "QUEUED") return;
    await this.addVerificationJob({
      verificationId: addressVerification.id,
      applicationId,
      type: addressVerification.type
    });
  }

  private async handleFailedJob(job: Job<VerificationJob> | undefined, error: Error): Promise<void> {
    if (!job) return;
    const verification = await this.store.getVerification(job.data.verificationId);
    const application = await this.store.getApplication(job.data.applicationId);
    if (!verification || !application || verification.applicationId !== application.id || verification.type !== job.data.type) return;
    if (["VERIFIED", "MANUAL_REVIEW", "PENDING"].includes(verification.status)) return;
    const owner = { tenantId: application.tenantId, clientId: application.clientId };
    const uncertain = await this.store.hasDispatchedCall(verification.id, owner);
    const providerError = error as Error & { code?: string };
    await this.store.setResult(verification.id, uncertain ? "MANUAL_REVIEW" : "FAILED", {
      failureCode: uncertain ? "PROVIDER_OUTCOME_UNKNOWN" : providerError.code || "PROVIDER_UNAVAILABLE",
      failureReason: uncertain ? "Provider accounting requires reconciliation; automatic replay is blocked" : "Provider request could not complete",
      attemptCount: Math.max(verification.attemptCount, job.attemptsMade)
    }, owner);
    if (uncertain || error.name === "UnrecoverableError" || job.attemptsMade >= (job.opts.attempts || 1)) {
      await this.purgeSensitiveInputsIfDone(application.id);
    }
    await this.store.recalculateApplicationStatus(application.id, owner);
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue.close();
    await this.connection.quit();
  }
}

