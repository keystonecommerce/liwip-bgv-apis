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
import { enabledProducts, isCheckAvailable } from "../../integrations/surepass/products";
import { AadhaarOvseService } from "../aadhaar-ovse/aadhaar-ovse.service";
import { VerificationQueue } from "../verifications/verification.queue";
import { VerificationStore } from "../verifications/verification.repository";
import {
  CHECK_TYPES_FOR,
  SELECTABLE_CHECKS,
  SelectableCheck,
  WorkerCheckKind,
  address,
  applyCheckInput,
  fatherFromCareOf,
  isSelectableCheck,
  isoDate,
  personName
} from "./worker-case.inputs";

const NEEDS_INPUT = new Set<VerificationType>(["AADHAAR", "PAN", "DRIVING_LICENSE", "RC_V2", "VOTER_ID", "PASSPORT", "EMPLOYMENT_HISTORY", "FACE_LIVENESS", "FACE_MATCH"]);
const SELFIE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export interface SelfieUpload { buffer: Buffer; originalname: string; mimetype: string; size: number }
export interface DetailsInput { fullName?: string; dateOfBirth?: string; fatherName?: string; address?: string }

/** A selectable check is offered only when every Surepass product behind it is enabled. */
function isSelectableAvailable(check: SelectableCheck): boolean {
  if (check === "AADHAAR") return enabledProducts().has("aadhaar-ovse");
  return SELECTABLE_CHECKS[check].types.every((type) => isCheckAvailable(type));
}

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

  /** The worker picks which checks to run. Only while the case is a draft. */
  async selectChecks(worker: WorkerIdentity, client: ClientContext, input: { checks?: string[] }) {
    const { application, owner } = await this.current(worker, client);
    if (application.status !== "DRAFT") throw new ConflictException("Checks are fixed once consent is given");
    const chosen = [...new Set((Array.isArray(input?.checks) ? input.checks : []).map((item) => String(item).toUpperCase()))];
    if (!chosen.length) throw new BadRequestException("Choose at least one check");
    for (const check of chosen) {
      if (!isSelectableCheck(check) || !isSelectableAvailable(check)) throw new BadRequestException(`${check} is not available`);
      const requires = SELECTABLE_CHECKS[check].requires;
      if (requires && !chosen.includes(requires)) throw new BadRequestException(`${check} needs ${requires} as well`);
    }
    const updated = await this.store.updateApplicationData(application.id, owner, (data) => ({ ...data, selectedChecks: chosen }));
    return this.view(updated, owner);
  }

  /** Consent covers exactly the chosen checks, then each one gets a row waiting for the worker. */
  async consent(worker: WorkerIdentity, client: ClientContext, input: { textVersion?: string; items?: string[] }) {
    const { application, owner } = await this.current(worker, client);
    if (application.status !== "DRAFT") return this.view(application, owner);
    const selected = (application.data.selectedChecks ?? []).filter(isSelectableCheck);
    if (!selected.length) throw new BadRequestException("Choose your checks first");
    const textVersion = String(input?.textVersion || "").trim();
    if (!/^[\w.-]{1,40}$/.test(textVersion)) throw new BadRequestException("Consent text version is required");
    const items = new Set((Array.isArray(input?.items) ? input.items : []).map(String));
    const required = [...new Set(["case", ...selected.map((check) => SELECTABLE_CHECKS[check].consent)])];
    const missing = required.filter((item) => !items.has(item));
    if (missing.length) throw new BadRequestException(`Consent is needed for: ${missing.join(", ")}`);

    const grantedAt = new Date().toISOString();
    await this.store.updateApplicationData(application.id, owner, (data) => ({
      ...data,
      consent: { granted: true, purpose: "Worker background verification", textVersion, grantedAt },
      consentItems: required,
      biometricConsent: items.has("face"),
      criminal: { ...data.criminal, consent: items.has("court") }
    }), { status: "PENDING_VERIFICATION" });
    await this.store.addVerifications(application.id, selected.flatMap((check) => SELECTABLE_CHECKS[check].types).map((type) => ({ type, status: "PENDING" as const })));
    return this.view(await this.reload(application.id, owner), owner);
  }

  /**
   * Name, date of birth, father's name and address. Typed by the worker when they
   * skip Aadhaar; with Aadhaar only the gaps (father's name, address) can be filled.
   */
  async saveDetails(worker: WorkerIdentity, client: ClientContext, input: DetailsInput) {
    const { application, owner } = await this.current(worker, client);
    this.requireConsent(application);
    const fromAadhaar = application.data.identity?.status === "VERIFIED";
    await this.store.updateApplicationData(application.id, owner, (data) => {
      const personal = { ...data.personal };
      if (!fromAadhaar) {
        personal.nameAsAadhaar = personName(input?.fullName, "Enter your full name as on your ID");
        const dob = isoDate(input?.dateOfBirth);
        if (!dob || new Date(dob) > new Date()) throw new BadRequestException("Enter your date of birth");
        personal.dateOfBirth = dob;
      }
      if (input?.address !== undefined && input.address !== "") personal.submittedAddress = address(input.address);
      const fatherName = input?.fatherName ? personName(input.fatherName, "Enter your father's name") : data.criminal?.fatherName;
      return { ...data, personal, criminal: { ...data.criminal, fatherName } };
    });
    await this.startReadyChecks(application.id, owner);
    return this.view(await this.reload(application.id, owner), owner);
  }

  async startAadhaar(worker: WorkerIdentity, client: ClientContext) {
    const { application, owner } = await this.current(worker, client);
    this.requireConsent(application);
    if (!(await this.rowsFor(application.id, ["AADHAAR"])).length) throw new BadRequestException("Aadhaar is not one of your chosen checks");
    if (application.data.identity?.status === "VERIFIED") throw new ConflictException("Your Aadhaar is already verified");
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
    const [row] = await this.rowsFor(application.id, ["AADHAAR"]);

    const { status } = await this.aadhaar.status(identity.sessionId, client);
    if (status === "failed" || status === "expired") {
      await this.store.updateApplicationData(application.id, owner, (data) => ({ ...data, identity: { ...identity, status: "FAILED" } }));
      if (row) await this.store.setResult(row.id, "FAILED", { failureCode: "AADHAAR_NOT_COMPLETED", failureReason: "Aadhaar verification was not completed. Try again." }, owner);
      await this.store.recalculateApplicationStatus(application.id, owner);
      return this.view(await this.reload(application.id, owner), owner);
    }
    if (status !== "completed") return this.view(application, owner);

    const result = await this.aadhaar.result(identity.sessionId, client);
    const fullName = String(result.full_name || "").trim();
    const dateOfBirth = isoDate(result.dob);
    if (!fullName || !dateOfBirth) throw new BadRequestException("Aadhaar did not return a name and date of birth. Try again.");
    const careOf = result.care_of?.trim();
    const fullAddress = result.full_address?.trim();
    await this.store.updateApplicationData(application.id, owner, (data) => ({
      ...data,
      identity: { ...identity, status: "VERIFIED", fullName, dateOfBirth, gender: result.gender, address: fullAddress, pincode: result.pincode, careOf, verifiedAt: new Date().toISOString() },
      personal: { ...data.personal, nameAsAadhaar: fullName, dateOfBirth, gender: result.gender, submittedAddress: fullAddress || data.personal.submittedAddress },
      criminal: { ...data.criminal, fatherName: data.criminal?.fatherName || fatherFromCareOf(careOf) }
    }));
    if (row) await this.store.setResult(row.id, "VERIFIED", { providerRequestId: identity.sessionId, result: { source: "AADHAAR_OVSE", nameOnAadhaar: fullName } }, owner);
    await this.startReadyChecks(application.id, owner);
    return this.view(await this.reload(application.id, owner), owner);
  }

  /** The worker submits input for one check (or a selfie) and it runs now. */
  async submitCheck(worker: WorkerIdentity, client: ClientContext, kind: WorkerCheckKind, input: Record<string, unknown>, selfie?: SelfieUpload) {
    const { application, owner } = await this.current(worker, client);
    this.requireConsent(application);
    if (!application.data.personal.nameAsAadhaar || !application.data.personal.dateOfBirth) {
      throw new BadRequestException("Verify Aadhaar or add your name and date of birth first");
    }
    const types = CHECK_TYPES_FOR[kind];
    const rows = await this.rowsFor(application.id, types);
    if (rows.length < types.length) throw new NotFoundException("This check is not one you chose");
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

  /** The court search runs on its own once name, father's name and address are known. */
  private async startReadyChecks(applicationId: string, owner: ApplicationOwner) {
    const { data } = await this.reload(applicationId, owner);
    const courtReady = Boolean(data.personal.nameAsAadhaar && data.criminal?.fatherName && data.personal.submittedAddress);
    for (const row of await this.store.getVerificationsForApplication(applicationId, owner)) {
      if (row.type === "ECOURTS_SEARCH" && row.status === "PENDING" && courtReady) await this.queueRow(row, applicationId, owner);
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
    if (identity?.source !== "AADHAAR_OVSE" || identity.status !== "VERIFIED") throw new BadRequestException("Verify Aadhaar first; face match uses the Aadhaar photo");
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

  /** What the worker app may see: states and the worker's own details, never raw provider data. */
  private async view(application: ApplicationRecord, owner: ApplicationOwner) {
    const data: ApplicationSchema = application.data;
    const rows = await this.store.getVerificationsForApplication(application.id, owner);
    const selected = data.selectedChecks ?? [];
    const courtReady = Boolean(data.personal.nameAsAadhaar && data.criminal?.fatherName && data.personal.submittedAddress);
    return {
      applicationId: application.id,
      cardNumber: application.card?.cardNumber ?? (await this.store.getCardNumber(application.id)) ?? null,
      status: application.status,
      catalog: (Object.keys(SELECTABLE_CHECKS) as SelectableCheck[]).map((check) => ({
        check,
        available: isSelectableAvailable(check),
        requires: SELECTABLE_CHECKS[check].requires ?? null,
        consent: SELECTABLE_CHECKS[check].consent,
        selected: selected.includes(check)
      })),
      selectedChecks: selected,
      consent: data.consent?.granted ? { textVersion: data.consent.textVersion, grantedAt: data.consent.grantedAt, items: data.consentItems ?? [] } : null,
      details: {
        source: data.identity?.status === "VERIFIED" ? "AADHAAR" : data.personal.nameAsAadhaar ? "WORKER" : null,
        fullName: data.personal.nameAsAadhaar || null,
        dateOfBirth: data.personal.dateOfBirth || null,
        fatherName: data.criminal?.fatherName ?? null,
        address: data.personal.submittedAddress ?? null
      },
      identity: data.identity ? { source: data.identity.source, status: data.identity.status } : null,
      checks: rows.map((row) => ({
        id: row.id,
        type: row.type,
        status: row.status,
        needsInput: row.status === "PENDING" && (NEEDS_INPUT.has(row.type) || (row.type === "ECOURTS_SEARCH" && !courtReady)),
        canResubmit: row.status === "FAILED" && NEEDS_INPUT.has(row.type),
        reason: row.status === "FAILED" || row.status === "MANUAL_REVIEW" ? row.failureReason ?? null : null,
        updatedAt: row.updatedAt
      })),
      card: application.card ? { status: application.card.status, issuedAt: application.card.issuedAt, expiresAt: application.card.expiresAt } : null
    };
  }
}
