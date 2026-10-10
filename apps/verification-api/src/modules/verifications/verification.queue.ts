import { redisConnectionOptions } from "../../config/redis";
import { providerCallContext } from "../usage/provider-call.context";
import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Job, Queue, Worker } from "bullmq";
import IORedis from "ioredis";
import { SensitiveVerificationInputs, VerificationJob, VerificationType } from "../../domain/verification.types";
import { VERIFICATION_PROVIDER, VerificationProvider } from "../../integrations/verification-provider";
import { VerificationStore } from "./verification.repository";
import { isoDate } from "../../domain/dates";
import { nameAnchors, panReferenceNames } from "../../domain/name-match";

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

/** Registry records already verified on the case, used as name anchors. */
export interface MatchContext {
  /** Opened by the worker (worker app). Partner cases keep the names the partner supplied. */
  workerCase?: boolean;
  /** Name and date of birth the PAN registry returned, once the PAN check passed. */
  pan?: { name?: string; dateOfBirth?: string } | null;
}

/**
 * Names and date of birth a document is matched against. For worker cases only registry
 * records count (verified Aadhaar, and a verified PAN that fits it); a name the worker typed
 * is never a reference for other documents. `official: false` sends name matches to review.
 * `dobConfirmed` means the registry looked the document up with the anchor date of birth,
 * so a looser name rule is safe.
 */
function matchInputs(data: Record<string, any>, context: MatchContext) {
  const personal = data.personal || {};
  if (!context.workerCase) {
    const names = [...new Set([personal.nameAsAadhaar, personal.declaredName].filter((name) => typeof name === "string" && name.trim()))];
    return { names, panNames: names, dateOfBirth: personal.dateOfBirth as string | undefined, official: true, dobConfirmed: false, workerCase: false };
  }
  const aadhaar = data.identity?.status === "VERIFIED" ? { name: data.identity.fullName, dateOfBirth: data.identity.dateOfBirth } : null;
  const anchors = nameAnchors({ aadhaar, pan: context.pan });
  return {
    names: anchors.names,
    panNames: panReferenceNames(aadhaar?.name, personal.declaredName),
    dateOfBirth: anchors.dateOfBirth ?? (personal.dateOfBirth as string | undefined),
    official: anchors.official,
    dobConfirmed: anchors.official && Boolean(anchors.dateOfBirth),
    workerCase: true
  };
}

function applicationToPayload(
  type: VerificationType,
  data: Record<string, any>,
  sensitiveInputs?: SensitiveVerificationInputs,
  officialAddress?: string,
  context: MatchContext = {}
): Record<string, unknown> {
  const personal = data.personal || {};
  const education = data.education || {};
  const vehicle = data.vehicle || {};
  const match = matchInputs(data, context);
  const names = match.names;
  // Documents looked up by number and date of birth use the official date when there is one,
  // never a different date typed for that document.
  const documentDob = match.workerCase && match.dobConfirmed ? match.dateOfBirth : undefined;
  const anchored = { official: match.official, dobConfirmed: match.dobConfirmed };
  if (type === "AADHAAR" && sensitiveInputs?.aadhaarPdf) return sensitiveInputs.aadhaarPdf as unknown as Record<string, unknown>;
  if (type === "AADHAAR") return { name: personal.nameAsAadhaar, dateOfBirth: personal.dateOfBirth, aadhaarReference: personal.aadhaarReference };
  // PAN is matched to Aadhaar (plus the typed full name when it fits Aadhaar) and its date of birth compared.
  if (type === "PAN") return { idNumber: personal.panNumber, name: match.panNames, official: match.workerCase ? match.panNames.length > 0 : true, anchorDob: match.workerCase ? data.identity?.dateOfBirth : undefined };
  if (type === "DRIVING_LICENSE") return { licenseNumber: personal.drivingLicenceNumber, name: names, dob: documentDob ?? (personal.drivingLicenceDob || personal.dateOfBirth), ...anchored };
  if (type === "VOTER_ID") return { idNumber: personal.voterId, fullName: names, dob: documentDob ?? personal.dateOfBirth, ...anchored };
  if (type === "ADDRESS_MATCHING") return { address1: personal.submittedAddress, address2: officialAddress };
  if (type === "RC_FULL") return { idNumber: vehicle.registrationNumber };
  // The RC lookup takes no date of birth, so its owner name is always matched strictly.
  if (type === "RC_V2") return { idNumber: vehicle.registrationNumber, name: names, official: match.official };
  if (type === "CIBIL_SCORE") return { pan: personal.panNumber, mobile: personal.phone, name: personal.nameAsAadhaar, gender: personal.gender };
  if (type === "PASSPORT") return { fileNumber: personal.passportFileNumber, dob: documentDob ?? personal.dateOfBirth, name: names, ...anchored };
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

/** Worker-facing reason when the provider says the number is not found or not valid. */
function rejectionReason(type: VerificationType): string {
  const what: Partial<Record<VerificationType, string>> = {
    PAN: "This PAN was not found",
    DRIVING_LICENSE: "This licence was not found for that date of birth",
    VOTER_ID: "This voter ID was not found",
    PASSPORT: "This passport file number was not found for your date of birth",
    RC_V2: "This vehicle number was not found",
    EMPLOYMENT_HISTORY: "No employment record was found for this UAN"
  };
  return `${what[type] ?? "This number was not found"}. Check it and try again.`;
}

@Injectable()
export class VerificationQueue implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(VerificationQueue.name);
  private readonly connection = new IORedis(redisConnectionOptions());
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
    if (await this.store.hasDispatchedCall(verification.id, owner, job.data.inputAfterAttempt)) {
      await this.store.setResult(verification.id, "MANUAL_REVIEW", { failureCode: "PROVIDER_OUTCOME_UNKNOWN", failureReason: "A dispatched provider call requires reconciliation before retrying" }, owner);
      await this.store.recalculateApplicationStatus(application.id, owner);
      return;
    }
    if (!await this.store.claimForProcessing(verification.id, owner, verification.attemptCount)) return;

    const applicationVerifications = await this.store.getVerificationsForApplication(application.id);
    const aadhaarVerification = applicationVerifications.find((item) => item.type === "AADHAAR");
    const officialAddress = formatAddress(aadhaarVerification?.result?.address || aadhaarVerification?.result?.permanent_address);
    const pan = applicationVerifications.find((item) => item.type === "PAN" && item.status === "VERIFIED")?.result;
    const context: MatchContext = {
      workerCase: application.workerCase,
      pan: pan ? { name: String(pan.full_name || pan.name || "") || undefined, dateOfBirth: isoDate(pan.dob) } : null
    };
    const response = await providerCallContext.run({ ...owner, apiKeyId: application.apiKeyId, applicationId: application.id, verificationId: verification.id, operationKey: `verification_${verification.id}_attempt_${verification.attemptCount + 1}` }, () => this.provider.verify(
      verification.type,
      applicationToPayload(verification.type, application.data as Record<string, any>, this.store.getSensitiveInputs(application.id), officialAddress, context)
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
    const uncertain = await this.store.hasDispatchedCall(verification.id, owner, job.data.inputAfterAttempt);
    const providerError = error as Error & { code?: string; providerResponse?: Record<string, unknown> | null };
    // A provider rejection (4xx) means the number was not found or not valid: tell the worker what to fix.
    const rejected = providerError.code === "PROVIDER_HTTP_ERROR";
    await this.store.setResult(verification.id, uncertain ? "MANUAL_REVIEW" : "FAILED", {
      failureCode: uncertain ? "PROVIDER_OUTCOME_UNKNOWN" : providerError.code || "PROVIDER_UNAVAILABLE",
      failureReason: uncertain
        ? "Provider accounting requires reconciliation; automatic replay is blocked"
        : rejected ? rejectionReason(verification.type) : "We could not complete this check. Try again in a few minutes.",
      failureResponse: providerError.providerResponse ?? null,
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

