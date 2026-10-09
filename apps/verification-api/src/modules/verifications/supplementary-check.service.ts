import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { createHash } from "node:crypto";
import { ApplicationOwner } from "../../domain/verification.types";
import { CheckFiles, isSupplementaryCheck, supplementaryChecks, validateCheck } from "../../domain/supplementary-checks";
import { VERIFICATION_PROVIDER, VerificationProvider } from "../../integrations/verification-provider";
import { VerificationStore } from "./verification.repository";

@Injectable()
export class SupplementaryCheckService {
  constructor(
    @Inject(VerificationStore) private readonly store: VerificationStore,
    @Inject(VERIFICATION_PROVIDER) private readonly provider: VerificationProvider
  ) {}

  list() {
    return Object.entries(supplementaryChecks).map(([type, spec]) => ({
      type, fields: spec.fields, files: "files" in spec ? spec.files : [], consent: spec.consent,
      execution: "synchronous", reviewRequired: !["NAME_MATCH", "IFSC"].includes(type)
    }));
  }

  async execute(applicationId: string, type: string, input: Record<string, unknown>, files: CheckFiles, requestKey: string, owner: ApplicationOwner) {
    if (!isSupplementaryCheck(type)) throw new BadRequestException("Unsupported check; see GET /v1/verification-checks");
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(requestKey || "")) throw new BadRequestException("Idempotency-Key must contain 16–128 letters, digits, underscores or hyphens");
    const application = await this.store.getApplication(applicationId, owner);
    if (!application) throw new NotFoundException("Application not found");
    if (application.data.consent?.granted !== true) throw new BadRequestException("Worker consent is required");
    const consent = supplementaryChecks[type].consent;
    if (consent === "credit" && application.data.creditConsent?.granted !== true) throw new BadRequestException("Recorded credit consent is required");
    if (consent === "address" && application.data.addressConsent !== true) throw new BadRequestException("Recorded address consent is required");
    validateCheck(type, input, files);
    const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
    const fingerprint = hash(JSON.stringify({ type,
      input: Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b))),
      files: Object.entries(files).sort(([a], [b]) => a.localeCompare(b)).map(([field, file]) => [field, file?.mimetype, file ? hash(file.buffer) : null])
    }));
    const id = `verification_${hash(`${applicationId}:${requestKey}`)}`;
    const claim = await this.store.createSupplementaryVerification(id, applicationId, type, this.provider.name, fingerprint);
    if (!claim.created) {
      if (claim.verification.result?.requestFingerprint !== fingerprint) throw new ConflictException("Idempotency-Key was already used with different inputs");
      return claim.verification;
    }
    try {
      await this.store.recalculateApplicationStatus(applicationId);
      const response = await this.provider.executeCheck(type, input, files);
      const status = response.status === "verified" ? "VERIFIED" : response.status === "failed" ? "FAILED" : response.status === "pending" ? "PENDING" : "MANUAL_REVIEW";
      await this.store.setResult(id, status, {
        providerRequestId: response.requestId,
        result: { ...(response.data || {}), requestFingerprint: fingerprint }
      });
    } catch (error) {
      const failure = error as Error & { code?: string };
      const unknown = failure.code === "PROVIDER_OUTCOME_UNKNOWN";
      await this.store.setResult(id, unknown ? "MANUAL_REVIEW" : "FAILED", {
        result: { requestFingerprint: fingerprint }, failureCode: failure.code || "PROVIDER_ERROR",
        failureReason: unknown ? "Provider outcome unknown; review before resubmitting" : "Provider could not complete this check"
      });
    } finally {
      await this.store.recalculateApplicationStatus(applicationId);
    }
    return this.store.getVerification(id, owner);
  }
}
