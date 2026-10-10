import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { ClientContext } from "../../common/auth/client-context";
import type { WorkerIdentity } from "../../common/auth/worker-token";
import type {
  ApplicationOwner,
  ApplicationRecord,
  ApplicationSchema,
  VerificationRecord,
  VerificationType
} from "../../domain/verification.types";
import { isCheckAvailable } from "../../integrations/surepass/products";
import { AadhaarOvseService } from "../aadhaar-ovse/aadhaar-ovse.service";
import { VerificationQueue } from "../verifications/verification.queue";
import { VerificationStore } from "../verifications/verification.repository";
import {
  CHECK_TYPES_FOR,
  WORKER_OPTIONAL_CHECKS,
  WorkerCheckKind,
  applyCheckInput,
  fatherFromCareOf,
  isoDate
} from "./worker-case.inputs";

const MANUAL_CHECKS = new Set<VerificationType>(["CURRENT_ADDRESS", "REFERENCE_CHECK", "SKILL_CERTIFICATION"]);
const NEEDS_INPUT = new Set<VerificationType>(["PAN", "DRIVING_LICENSE", "RC_V2", "VOTER_ID", "PASSPORT", "EMPLOYMENT_HISTORY", "FACE_LIVENESS", "FACE_MATCH"]);
const SELFIE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export interface SelfieUpload { buffer: Buffer; originalname: string; mimetype: string; size: number }

@Injectable()
export class WorkerCaseService {
  constructor(
    @Inject(VerificationStore) private readonly store: VerificationStore,
    @Inject(VerificationQueue) private readonly queue: VerificationQueue,
    @Inject(AadhaarOvseService) private readonly aadhaar: AadhaarOvseService
  ) {}

  /** Returns the worker's case, opening a draft on first sign-in. */
  async open(worker: WorkerIdentity, client: ClientContext) {
    const owner = this.owner(client);
    const existing = await this.store.findWorkerCase(owner, worker.phone);
    const application = existing ?? await this.store.createWorkerDraft(owner, worker.phone, {
      personal: { phone: worker.phone.slice(2), nameAsAadhaar: "", dateOfBirth: "" }
    });
    return this.view(application, owner);
  }

  async choosePackage(worker: WorkerIdentity, client: ClientContext, packageCode: string) {
    const { application, owner } = await this.current(worker, client);
    if (application.status !== "DRAFT") throw new ConflictException("The package is fixed once consent is given");
    const pkg = await this.store.getPackageByCode(String(packageCode || ""));
    if (!pkg || !pkg.isActive || pkg.kind !== "BASE") throw new BadRequestException("Choose one of the listed packages");
    const updated = await this.store.updateApplicationData(application.id, owner,
      (data) => ({ ...data, packageCode: pkg.code, packageVersion: pkg.version }), { packageId: pkg.id });
    return this.view(updated, owner);
  }

  /** Consent opens the case: each check in the package gets a row, waiting for the worker. */
  async consent(worker: WorkerIdentity, client: ClientContext, input: { textVersion?: string; items?: string[] }) {
    const { application, owner } = await this.current(worker, client);
    if (application.status !== "DRAFT") return this.view(application, owner);
    if (!application.data.packageCode) throw new BadRequestException("Choose a package first");
    const pkg = await this.store.getPackageByCode(application.data.packageCode, application.data.packageVersion);
    if (!pkg) throw new BadRequestException("Choose a package first");
    const textVersion = String(input?.textVersion || "").trim();
    if (!/^[\w.-]{1,40}$/.test(textVersion)) throw new BadRequestException("Consent text version is required");
    const items = new Set((Array.isArray(input?.items) ? input.items : []).map(String));
    const checks = pkg.checks.filter((rule) => isCheckAvailable(rule.type));
    const required = ["case", "identity", "face"];
    if (checks.some((rule) => rule.type === "ECOURTS_SEARCH")) required.push("court");
    if (checks.some((rule) => rule.type === "CURRENT_ADDRESS")) required.push("address");
    const missing = required.filter((item) => !items.has(item));
    if (missing.length) throw new BadRequestException(`Consent is needed for: ${missing.join(", ")}`);

    const grantedAt = new Date().toISOString();
    await this.store.updateApplicationData(application.id, owner, (data) => ({
      ...data,
      consent: { granted: true, purpose: "Worker background verification", textVersion, grantedAt },
      consentItems: [...items],
      biometricConsent: items.has("face"),
      addressConsent: items.has("address"),
      criminal: { ...data.criminal, consent: items.has("court") }
    }), { status: "PENDING_VERIFICATION" });
    await this.store.addVerifications(application.id, checks.map((rule) => ({ type: rule.type, status: "PENDING" })));
    return this.view(await this.reload(application.id, owner), owner);
  }

  async startAadhaar(worker: WorkerIdentity, client: ClientContext) {
    const { application, owner } = await this.current(worker, client);
    this.requireConsent(application);
    if (application.data.identity?.status === "VERIFIED") throw new ConflictException("Your identity is already verified");
    const session = await this.aadhaar.initialize({ channel: "web", redirect_url: process.env.WORKER_AADHAAR_RETURN_URL || undefined }, client);
    await this.store.updateApplicationData(application.id, owner, (data) => ({
      ...data, identity: { source: "AADHAAR_OVSE", sessionId: session.client_id, status: "PENDING" }
    }));
    return { url: session.web_link };
  }

  /** Called when the worker returns from Aadhaar. Safe to call repeatedly. */
  async completeAadhaar(worker: WorkerIdentity, client: ClientContext) {
    const { application, owner } = await this.current(worker, client);
    const identity = application.data.identity;
    if (!identity || identity.source !== "AADHAAR_OVSE") throw new BadRequestException("Start Aadhaar verification first");
    if (identity.status === "VERIFIED") return this.view(application, owner);

    const { status } = await this.aadhaar.status(identity.sessionId, client);
    if (status === "failed" || status === "expired") {
      await this.store.updateApplicationData(application.id, owner, (data) => ({ ...data, identity: { ...identity, status: "FAILED" } }));
      return this.view(await this.reload(application.id, owner), owner);
    }
    if (status !== "completed") return this.view(application, owner);

    const result = await this.aadhaar.result(identity.sessionId, client);
    const fullName = String(result.full_name || "").trim();
    const dateOfBirth = isoDate(result.dob);
    if (!fullName || !dateOfBirth) throw new BadRequestException("Aadhaar did not return a name and date of birth. Try again.");
    const careOf = result.care_of?.trim();
    const address = result.full_address?.trim();
    await this.store.updateApplicationData(application.id, owner, (data) => ({
      ...data,
      identity: { ...identity, status: "VERIFIED", fullName, dateOfBirth, gender: result.gender, address, pincode: result.pincode, careOf, verifiedAt: new Date().toISOString() },
      personal: { ...data.personal, nameAsAadhaar: fullName, dateOfBirth, gender: result.gender, submittedAddress: address || data.personal.submittedAddress },
      criminal: { ...data.criminal, fatherName: data.criminal?.fatherName || fatherFromCareOf(careOf) }
    }));
    await this.startChecksAfterIdentity(application.id, owner);
    return this.view(await this.reload(application.id, owner), owner);
  }

  /** The worker submits input for one check (or a selfie) and it runs now. */
  async submitCheck(worker: WorkerIdentity, client: ClientContext, kind: WorkerCheckKind, input: Record<string, unknown>, selfie?: SelfieUpload) {
    const { application, owner } = await this.current(worker, client);
    this.requireConsent(application);
    if (application.data.identity?.status !== "VERIFIED") throw new BadRequestException("Verify your identity with Aadhaar first");

    const types = CHECK_TYPES_FOR[kind];
    let rows = await this.rowsFor(application.id, types);
    if (rows.length < types.length) {
      const addable = types.filter((type) => WORKER_OPTIONAL_CHECKS.has(type) && isCheckAvailable(type) && !rows.some((row) => row.type === type));
      if (addable.length !== types.length - rows.length) throw new NotFoundException("This check is not part of your package");
      await this.store.addVerifications(application.id, addable.map((type) => ({ type, status: "PENDING" })));
      rows = await this.rowsFor(application.id, types);
    }
    if (rows.some((row) => row.status !== "PENDING" && row.status !== "FAILED")) throw new ConflictException("This check is already running or done");

    if (kind === "FACE") {
      if (!selfie || !SELFIE_TYPES.has(selfie.mimetype) || selfie.size > 5 * 1024 * 1024) throw new BadRequestException("Take a clear photo (JPEG or PNG, up to 5 MB)");
      const photo = await this.aadhaarPhoto(application, client);
      this.store.setSensitiveInputs(application.id, {
        ...this.store.getSensitiveInputs(application.id),
        selfie: { buffer: selfie.buffer, originalname: selfie.originalname || "selfie.jpg", mimetype: selfie.mimetype },
        idCard: photo
      });
      await this.store.updateApplicationData(application.id, owner, (data) => ({
        ...data, documents: { ...data.documents, selfie: { fileName: "selfie" }, idCard: { fileName: "aadhaar-photo" } }
      }));
    } else {
      await this.store.updateApplicationData(application.id, owner, (data) => applyCheckInput(kind, input, data));
    }

    for (const row of rows) await this.queueRow(row, application.id, owner);
    await this.store.recalculateApplicationStatus(application.id, owner);
    return this.view(await this.reload(application.id, owner), owner);
  }

  private async startChecksAfterIdentity(applicationId: string, owner: ApplicationOwner) {
    const application = await this.reload(applicationId, owner);
    for (const row of await this.store.getVerificationsForApplication(applicationId, owner)) {
      if (row.status !== "PENDING") continue;
      if (row.type === "ECOURTS_SEARCH" && application.data.criminal?.fatherName) await this.queueRow(row, applicationId, owner);
      // Physical checks go to the field-vendor lane now that the address is known.
      if (MANUAL_CHECKS.has(row.type)) {
        await this.store.setResult(row.id, "MANUAL_REVIEW", { result: { source: "package-rule", reason: "Assigned to a field verifier" } }, owner);
      }
    }
    await this.store.recalculateApplicationStatus(applicationId, owner);
  }

  private async queueRow(row: VerificationRecord, applicationId: string, owner: ApplicationOwner) {
    await this.store.updateVerification(row.id, { status: "QUEUED", failureCode: null as unknown as string, failureReason: null as unknown as string }, owner);
    await this.queue.addVerificationJob({ verificationId: row.id, applicationId, type: row.type, inputAfterAttempt: row.attemptCount });
  }

  /** The Aadhaar photo is the reference image for face match. */
  private async aadhaarPhoto(application: ApplicationRecord, client: ClientContext) {
    const identity = application.data.identity;
    if (identity?.source !== "AADHAAR_OVSE") throw new BadRequestException("Face match needs the photo from Aadhaar verification");
    const result = await this.aadhaar.result(identity.sessionId, client);
    const base64 = String(result.profile_image || "").replace(/^data:image\/\w+;base64,/, "");
    if (!base64) throw new BadRequestException("Aadhaar did not return a photo to match against");
    return { buffer: Buffer.from(base64, "base64"), originalname: "aadhaar-photo.jpg", mimetype: "image/jpeg" };
  }

  private async rowsFor(applicationId: string, types: VerificationType[]) {
    const rows = await this.store.getVerificationsForApplication(applicationId);
    // Latest row per type.
    return types.map((type) => rows.filter((row) => row.type === type).at(-1)).filter((row): row is VerificationRecord => Boolean(row));
  }

  private requireConsent(application: ApplicationRecord) {
    if (application.status === "DRAFT") throw new BadRequestException("Give consent before starting checks");
  }

  private async current(worker: WorkerIdentity, client: ClientContext) {
    const owner = this.owner(client);
    const application = await this.store.findWorkerCase(owner, worker.phone);
    if (!application) throw new NotFoundException("Open your case first");
    return { application, owner };
  }

  private async reload(id: string, owner: ApplicationOwner) {
    const application = await this.store.getApplication(id, owner);
    if (!application) throw new NotFoundException("Case not found");
    return application;
  }

  private owner(client: ClientContext): ApplicationOwner {
    return { tenantId: client.tenantId, clientId: client.clientId, apiKeyId: client.apiKeyId };
  }

  /** What the worker app may see: states and the worker's own identity, never raw provider data. */
  private async view(application: ApplicationRecord, owner: ApplicationOwner) {
    const data: ApplicationSchema = application.data;
    const rows = await this.store.getVerificationsForApplication(application.id, owner);
    const identity = data.identity;
    return {
      applicationId: application.id,
      cardNumber: await this.cardNumberFor(application),
      status: application.status,
      packageCode: data.packageCode ?? null,
      consent: data.consent?.granted ? { textVersion: data.consent.textVersion, grantedAt: data.consent.grantedAt, items: data.consentItems ?? [] } : null,
      identity: identity ? {
        source: identity.source,
        status: identity.status,
        fullName: identity.fullName ?? null,
        dateOfBirth: identity.dateOfBirth ?? null,
        address: identity.address ?? null,
        fatherName: data.criminal?.fatherName ?? null
      } : null,
      checks: rows.map((row) => ({
        id: row.id,
        type: row.type,
        status: row.status,
        needsInput: row.status === "PENDING" && (NEEDS_INPUT.has(row.type) || (row.type === "ECOURTS_SEARCH" && !data.criminal?.fatherName)),
        canResubmit: row.status === "FAILED" && NEEDS_INPUT.has(row.type),
        reason: row.status === "FAILED" || row.status === "MANUAL_REVIEW" ? row.failureReason ?? null : null,
        updatedAt: row.updatedAt
      })),
      optionalChecks: [...WORKER_OPTIONAL_CHECKS].filter((type) => isCheckAvailable(type) && !rows.some((row) => row.type === type)),
      card: application.card ? { status: application.card.status, issuedAt: application.card.issuedAt, expiresAt: application.card.expiresAt } : null
    };
  }

  private async cardNumberFor(application: ApplicationRecord): Promise<string | null> {
    return application.card?.cardNumber ?? (await this.store.getCardNumber(application.id)) ?? null;
  }
}
