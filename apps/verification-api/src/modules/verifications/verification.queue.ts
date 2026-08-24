import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Job, Queue, Worker } from "bullmq";
import IORedis from "ioredis";
import { SensitiveVerificationInputs, VerificationJob, VerificationType } from "../../domain/verification.types";
import { SurepassProvider } from "../../integrations/surepass/surepass.provider";
import { VerificationStore } from "./verification.repository";

const connectionOptions = {
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: Number(process.env.REDIS_PORT || 6380),
  maxRetriesPerRequest: null as null
};

// Keep this demo's jobs separate from queues used by other local projects.
// This matters because the demo store is in-memory and belongs to one API process.
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
  if (type === "PAN") return { idNumber: personal.panNumber };
  if (type === "DRIVING_LICENSE") return { licenseNumber: personal.drivingLicenceNumber, name: personal.nameAsAadhaar, dob: personal.drivingLicenceDob || personal.dateOfBirth };
  if (type === "VOTER_ID") return { idNumber: personal.voterId, fullName: personal.nameAsAadhaar, dob: personal.dateOfBirth };
  if (type === "ADDRESS_MATCHING") return { address1: personal.submittedAddress, address2: officialAddress };
  if (type === "RC_FULL") return { idNumber: vehicle.registrationNumber };
  if (type === "RC_V2") return { idNumber: vehicle.registrationNumber };
  if (type === "CIBIL_SCORE") return { pan: personal.panNumber, mobile: personal.phone, name: personal.nameAsAadhaar, gender: personal.gender };
  if (type === "PASSPORT") return { fileNumber: personal.passportFileNumber, dob: personal.dateOfBirth };
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
    @Inject(SurepassProvider) private readonly provider: SurepassProvider
  ) {}

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
    if (!verification || !application) throw new Error("Verification or application not found");
    if (verification.status === "VERIFIED") return;

    await this.store.setProcessing(verification.id);
    await this.store.updateVerification(verification.id, { attemptCount: job.attemptsMade + 1 });

    const applicationVerifications = await this.store.getVerificationsForApplication(application.id);
    const aadhaarVerification = applicationVerifications.find((item) => item.type === "AADHAAR");
    const officialAddress = formatAddress(aadhaarVerification?.result?.address || aadhaarVerification?.result?.permanent_address);
    const response = await this.provider.verify(
      verification.type,
      applicationToPayload(verification.type, application.data as Record<string, any>, this.store.getSensitiveInputs(application.id), officialAddress)
    );

    if (response.status === "verified") {
      await this.store.setResult(verification.id, "VERIFIED", { providerRequestId: response.requestId, result: response.data || {} });
      if (verification.type === "AADHAAR") await this.queueAddressMatch(application.id);
    } else if (response.status === "manual_review") {
      await this.store.setResult(verification.id, "MANUAL_REVIEW", { providerRequestId: response.requestId, result: response.data || {} });
    } else if (response.status === "pending") {
      await this.store.updateVerification(verification.id, { status: "PENDING", providerRequestId: response.requestId, result: response.data || undefined });
    } else {
      await this.store.setResult(verification.id, "FAILED", {
        providerRequestId: response.requestId,
        result: response.data || {},
        failureCode: "VERIFICATION_FAILED",
        failureReason: "Provider returned a failed verification result"
      });
    }
    await this.store.recalculateApplicationStatus(application.id);
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
    const isUnrecoverable = error.name === "UnrecoverableError";
    const attemptsExhausted = job.attemptsMade >= (job.opts.attempts || 1);
    if (!isUnrecoverable && !attemptsExhausted) return;
    const verification = await this.store.getVerification(job.data.verificationId);
    if (!verification) return;
    const providerError = error as Error & { code?: string; providerResponse?: Record<string, unknown> | null };
    await this.store.setResult(job.data.verificationId, "FAILED", {
      failureCode: providerError.code || "PROVIDER_UNAVAILABLE",
      failureReason: error.message,
      failureResponse: providerError.providerResponse,
      attemptCount: job.attemptsMade
    });
    await this.store.recalculateApplicationStatus(job.data.applicationId);
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue.close();
    await this.connection.quit();
  }
}
