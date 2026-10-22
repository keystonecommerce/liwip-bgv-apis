import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, ServiceUnavailableException, UnprocessableEntityException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { ClientContext } from "../../common/auth/client-context";
import type { WorkerIdentity } from "../../common/auth/worker-token";
import type {
  ApplicationOwner,
  ApplicationRecord,
  ApplicationSchema,
  VerificationType
} from "../../domain/verification.types";
import { checkedFileType } from "../../domain/file-types";
import { namesMatch } from "../../domain/name-match";
import type { CheckFiles } from "../../domain/supplementary-checks";
import { isCheckAvailable } from "../../integrations/surepass/products";
import { providerCallContext } from "../usage/provider-call.context";
import { VERIFICATION_PROVIDER, VerificationProvider } from "../../integrations/verification-provider";
import { AadhaarOvseService } from "../aadhaar-ovse/aadhaar-ovse.service";
import { DigiLockerService } from "../digilocker/digilocker.service";
import { PrismaService } from "../../common/database/prisma.service";
import { VerificationQueue } from "../verifications/verification.queue";
import { VerificationStore } from "../verifications/verification.repository";
import { latestRows, queueRow, startReadyChecks } from "./case-rows";
import { DigiLockerCompletionQueue } from "./digilocker/completion.queue";
import { DigiLockerCompletion, digiLockerPending } from "./digilocker/completion.service";
import { DIGILOCKER_DOCUMENTS } from "./digilocker/documents";
import { READABLE_DOCUMENTS, ReadableKind, canReadDocument, readingFrom } from "./document-reading";
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

const NEEDS_INPUT = new Set<VerificationType>(["AADHAAR", "PAN", "DRIVING_LICENSE", "RC_V2", "VOTER_ID", "PASSPORT", "EMPLOYMENT_HISTORY", "ELECTRICITY_BILL", "FACE_LIVENESS", "FACE_MATCH"]);
const SELFIE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
/** Checks a DigiLocker document can fill (PAN, licence, RC). */
const SHAREABLE_TYPES = Object.values(DIGILOCKER_DOCUMENTS).flatMap((spec) => CHECK_TYPES_FOR[spec.check]);

export interface SelfieUpload { buffer: Buffer; originalname: string; mimetype: string; size: number }
export type DocumentPhoto = SelfieUpload;
const DOCUMENT_PHOTO_TYPES = ["image/jpeg", "image/png", "application/pdf"] as const;
const MAX_DOCUMENT_PHOTO_BYTES = 5 * 1024 * 1024;
export interface DetailsInput { fullName?: string; dateOfBirth?: string; fatherName?: string; address?: string }
export interface ElectricityOperator { state: string; operatorCode: string }

/** The board list changes rarely; one fetch a day serves every worker. */
const OPERATORS_TTL_MS = 24 * 60 * 60 * 1000;
let operatorsCache: { at: number; list: ElectricityOperator[] } | null = null;

/** A selectable check is offered only when a Surepass product can serve every part of it. */
export function isSelectableAvailable(check: SelectableCheck): boolean {
  return SELECTABLE_CHECKS[check].types.every((type) => isCheckAvailable(type));
}

/**
 * Development and tests only, until the worker pay flow is built: WORKER_UNPAID_CHECKS=allow lets
 * chosen checks run without a bundle. Never in production, whatever the env says.
 */
const unpaidChecksAllowed = () => process.env.WORKER_UNPAID_CHECKS === "allow" && process.env.NODE_ENV !== "production";

@Injectable()
export class WorkerCaseService {
  constructor(
    @Inject(VerificationStore) private readonly store: VerificationStore,
    @Inject(VerificationQueue) private readonly queue: VerificationQueue,
    @Inject(AadhaarOvseService) private readonly aadhaar: AadhaarOvseService,
    @Inject(DigiLockerService) private readonly digilocker: DigiLockerService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(DigiLockerCompletion) private readonly completion: DigiLockerCompletion,
    @Inject(DigiLockerCompletionQueue) private readonly completionQueue: DigiLockerCompletionQueue,
    @Inject(VERIFICATION_PROVIDER) private readonly provider: VerificationProvider
  ) {}

  /** Electricity boards the worker picks from for the electricity bill check, by state. */
  async electricityOperators(): Promise<ElectricityOperator[]> {
    if (!isCheckAvailable("ELECTRICITY_BILL")) return [];
    if (operatorsCache && Date.now() - operatorsCache.at < OPERATORS_TTL_MS) return operatorsCache.list;
    const raw = await this.provider.listElectricityOperators();
    const data = raw.body?.data;
    if (raw.statusCode >= 400 || !Array.isArray(data)) throw new ServiceUnavailableException("Electricity boards are not available right now. Try again later.");
    const list = data
      .map((item) => ({ state: String(item?.state ?? "").trim(), operatorCode: String(item?.operator_code ?? "").trim().toUpperCase() }))
      .filter((item) => item.state && /^[A-Z]{2,5}$/.test(item.operatorCode))
      .sort((a, b) => a.state.localeCompare(b.state) || a.operatorCode.localeCompare(b.operatorCode));
    operatorsCache = { at: Date.now(), list };
    return list;
  }

  /** Returns the worker's case, opening a draft on first sign-in. */
  async open(worker: WorkerIdentity, client: ClientContext) {
    const owner = this.owner(client);
    const existing = await this.store.findWorkerCase(owner, worker.phone);
    const application = existing ?? await this.store.createWorkerDraft(owner, worker.phone, {
      personal: { phone: worker.phone.slice(2), nameAsAadhaar: "", dateOfBirth: "" }
    });
    return this.view(application, owner);
  }

  /**
   * The worker's name as printed on Aadhaar, asked right after OTP. Used to greet
   * them and, if they skip Aadhaar, to match their documents. A verified Aadhaar
   * name replaces it and cannot be overwritten.
   */
  async saveName(worker: WorkerIdentity, client: ClientContext, fullName: unknown) {
    const { application, owner } = await this.current(worker, client);
    const name = personName(fullName, "Enter your full name as on your PAN card");
    const aadhaarVerified = application.data.identity?.status === "VERIFIED";
    // Kept as typed. Until Aadhaar is verified it is also the name checks are matched to;
    // after that it is only a hint for the PAN check, where it must fit the Aadhaar name (see panReferenceNames).
    const updated = await this.store.updateApplicationData(application.id, owner, (data) => ({
      ...data, personal: { ...data.personal, declaredName: name, ...(aadhaarVerified ? {} : { nameAsAadhaar: name }) }
    }));
    return this.view(updated, owner);
  }

  /** The worker picks which checks to run. Only while the case is a draft. */
  async selectChecks(worker: WorkerIdentity, client: ClientContext, input: { checks?: string[] }) {
    const { application, owner } = await this.current(worker, client);
    if (application.status !== "DRAFT") throw new ConflictException("Checks are fixed once consent is given");
    if (application.data.sponsor) throw new ConflictException(`${application.data.sponsor.partnerName} chose the checks for you`);
    const picked = (Array.isArray(input?.checks) ? input.checks : []).map((item) => String(item).toUpperCase());
    if (!picked.length) throw new BadRequestException("Choose at least one check");
    // Aadhaar is in every case and every bundle: always first, never left out.
    const chosen = [...new Set([...(isSelectableAvailable("AADHAAR") ? ["AADHAAR"] : []), ...picked])];
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
    // Checks run only once paid for: by the person's bundle or a company's seat.
    if (!unpaidChecksAllowed()) {
      const paid = new Set(await this.paidTypes(application.id));
      const owed = selected.filter((check) => SELECTABLE_CHECKS[check].types.some((type) => !paid.has(type)));
      if (owed.length) throw new ConflictException(`Buy a bundle with ${owed.join(", ")} first`);
    }

    const grantedAt = new Date().toISOString();
    await this.store.updateApplicationData(application.id, owner, (data) => ({
      ...data,
      consent: { granted: true, purpose: "Worker background verification", textVersion, grantedAt },
      consentItems: required,
      biometricConsent: items.has("face"),
      addressConsent: items.has("address"),
      criminal: { ...data.criminal, consent: items.has("court") }
    }), { status: "PENDING_VERIFICATION" });
    await this.store.addVerifications(application.id, selected.flatMap((check) => SELECTABLE_CHECKS[check].types).map((type) => ({ type, status: "PENDING" as const })));
    return this.view(await this.reload(application.id, owner), owner);
  }

  /**
   * Adds checks to a case that is already under way, for example after the card is
   * issued. Consent covers only the new purposes; the card stays valid and shows as
   * updating until the new checks finish.
   */
  async addChecks(worker: WorkerIdentity, client: ClientContext, input: { checks?: string[]; items?: string[]; textVersion?: string }) {
    const { application, owner } = await this.current(worker, client);
    this.requireConsent(application);
    const existing = new Set(application.data.selectedChecks ?? []);
    const added = [...new Set((Array.isArray(input?.checks) ? input.checks : []).map((item) => String(item).toUpperCase()))].filter((check) => !existing.has(check));
    if (!added.length) throw new BadRequestException("Choose at least one new check");
    for (const check of added) {
      if (!isSelectableCheck(check) || !isSelectableAvailable(check)) throw new BadRequestException(`${check} is not available`);
      const requires = SELECTABLE_CHECKS[check].requires;
      if (requires && !existing.has(requires) && !added.includes(requires)) throw new BadRequestException(`${check} needs ${requires} as well`);
    }
    // An extra check is bought first (POST /v1/worker/billing/extras/quotes), then added. Whoever paid for the case paid only for its bundle.
    const paid = new Set(await this.paidTypes(application.id));
    const unpaid = added.filter((check) => SELECTABLE_CHECKS[check as SelectableCheck].types.some((type) => !paid.has(type)));
    if (unpaid.length) throw new ConflictException(`Pay for ${unpaid.join(", ")} first`);
    const items = new Set((Array.isArray(input?.items) ? input.items : []).map(String));
    const already = new Set(application.data.consentItems ?? []);
    const needed = [...new Set(added.map((check) => SELECTABLE_CHECKS[check as SelectableCheck].consent))].filter((item) => !already.has(item));
    const missing = needed.filter((item) => !items.has(item));
    if (missing.length) throw new BadRequestException(`Consent is needed for: ${missing.join(", ")}`);
    await this.store.updateApplicationData(application.id, owner, (data) => ({
      ...data,
      selectedChecks: [...(data.selectedChecks ?? []), ...added],
      consentItems: [...new Set([...(data.consentItems ?? []), ...needed])],
      biometricConsent: data.biometricConsent || needed.includes("face"),
      addressConsent: data.addressConsent || needed.includes("address"),
      criminal: { ...data.criminal, consent: data.criminal?.consent || needed.includes("court") }
    }));
    await this.store.addVerifications(application.id, added.flatMap((check) => SELECTABLE_CHECKS[check as SelectableCheck].types).map((type) => ({ type, status: "PENDING" as const })));
    await startReadyChecks(this.store, this.queue, application.id, owner);
    return this.view(await this.reload(application.id, owner), owner);
  }

  /**
   * Name, date of birth, father's name and address. Typed by the worker when they
   * did not choose Aadhaar; with Aadhaar only the gaps (father's name, address) can be filled.
   */
  async saveDetails(worker: WorkerIdentity, client: ClientContext, input: DetailsInput) {
    const { application, owner } = await this.current(worker, client);
    this.requireConsent(application);
    const fromAadhaar = application.data.identity?.status === "VERIFIED";
    // A worker who chose Aadhaar gets name and DOB from Aadhaar; typing them cannot replace it.
    const aadhaarChosen = (application.data.selectedChecks ?? []).includes("AADHAAR");
    await this.store.updateApplicationData(application.id, owner, (data) => {
      const personal = { ...data.personal };
      if (!fromAadhaar && !aadhaarChosen) {
        personal.nameAsAadhaar = personName(input?.fullName, "Enter your full name as on your ID");
        const dob = isoDate(input?.dateOfBirth);
        if (!dob || new Date(dob) > new Date()) throw new BadRequestException("Enter your date of birth");
        personal.dateOfBirth = dob;
      }
      if (input?.address !== undefined && input.address !== "") personal.submittedAddress = address(input.address);
      const fatherName = input?.fatherName ? personName(input.fatherName, "Enter your father's name") : data.criminal?.fatherName;
      return { ...data, personal, criminal: { ...data.criminal, fatherName } };
    });
    await startReadyChecks(this.store, this.queue, application.id, owner);
    return this.view(await this.reload(application.id, owner), owner);
  }

  async startAadhaar(worker: WorkerIdentity, client: ClientContext) {
    const { application, owner } = await this.current(worker, client);
    this.requireConsent(application);
    if (!(await latestRows(this.store, application.id, ["AADHAAR"])).length) throw new BadRequestException("Aadhaar is not one of your chosen checks");
    if (application.data.identity?.status === "VERIFIED") throw new ConflictException("Your Aadhaar is already verified");
    const session = await this.aadhaar.initialize({ channel: "web", redirect_url: process.env.WORKER_AADHAAR_RETURN_URL || undefined }, client);
    await this.store.updateApplicationData(application.id, owner, (data) => ({
      ...data, identity: { source: "AADHAAR_OVSE", sessionId: session.client_id, status: "PENDING" }
    }));
    // The signed request opens the official Aadhaar app directly; web_link is Surepass's hosted launcher.
    return { url: session.web_link, intentData: typeof session.intent_data === "string" ? session.intent_data : null };
  }

  /**
   * DigiLocker: a web page with mobile OTP. The first session verifies Aadhaar and reads any
   * documents shared with it. Once Aadhaar is verified, a later session only shares documents,
   * for checks added after it. Either way the server watches the session in the background.
   */
  async startDigiLocker(worker: WorkerIdentity, client: ClientContext) {
    const { application, owner } = await this.current(worker, client);
    this.requireConsent(application);
    const identityDone = application.data.identity?.status === "VERIFIED";
    if (identityDone) {
      const shareable = await latestRows(this.store, application.id, SHAREABLE_TYPES);
      if (!shareable.some((row) => row.status === "PENDING" || row.status === "FAILED")) throw new ConflictException("No checks are waiting for a DigiLocker document");
    } else if (!(await latestRows(this.store, application.id, ["AADHAAR"])).length) {
      throw new BadRequestException("Aadhaar is not one of your chosen checks");
    }
    const session = await this.digilocker.initialize({ data: {
      signup_flow: true,
      auth_type: "web",
      aadhaar_xml: !identityDone,
      expiry_minutes: 10,
      redirect_url: process.env.WORKER_DIGILOCKER_RETURN_URL || undefined,
      prefill_options: { mobile_number: worker.phone.slice(2) }
    } }, client);
    const startedAt = new Date().toISOString();
    await this.store.updateApplicationData(application.id, owner, (data) => identityDone
      ? { ...data, digilockerDocuments: { sessionId: session.client_id, status: "PENDING", startedAt } }
      : { ...data, identity: { source: "DIGILOCKER", sessionId: session.client_id, status: "PENDING" } });
    await this.completionQueue.watch(application.id, owner);
    return { url: session.url };
  }

  /** Called when the worker returns from the Aadhaar app or DigiLocker. Safe to call repeatedly. */
  async completeAadhaar(worker: WorkerIdentity, client: ClientContext) {
    const { application, owner } = await this.current(worker, client);
    const identity = application.data.identity;
    if (!identity) throw new BadRequestException("Start Aadhaar verification first");
    if (digiLockerPending(application.data)) {
      // Usually done already by the background job; if not, finish it now while the worker waits.
      await this.completion.run(application.id, owner);
      return this.view(await this.reload(application.id, owner), owner);
    }
    if (identity.status === "VERIFIED" || identity.source === "DIGILOCKER") return this.view(application, owner);
    // The app polls every few seconds; ask the provider at most every 10 seconds.
    if (identity.checkedAt && Date.now() - Date.parse(identity.checkedAt) < 10_000) return this.view(application, owner);
    await this.store.updateApplicationData(application.id, owner, (data) => ({ ...data, identity: { ...identity, checkedAt: new Date().toISOString() } }));
    const [row] = await latestRows(this.store, application.id, ["AADHAAR"]);

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
    await startReadyChecks(this.store, this.queue, application.id, owner);
    return this.view(await this.reload(application.id, owner), owner);
  }

  /** The worker submits input for one check (or a selfie) and it runs now. */
  async submitCheck(worker: WorkerIdentity, client: ClientContext, kind: WorkerCheckKind, input: Record<string, unknown>, selfie?: SelfieUpload) {
    const { application, owner } = await this.current(worker, client);
    this.requireConsent(application);
    if ((application.data.selectedChecks ?? []).includes("AADHAAR") && application.data.identity?.status !== "VERIFIED") {
      throw new BadRequestException("Verify your Aadhaar first");
    }
    if (!application.data.personal.nameAsAadhaar || !application.data.personal.dateOfBirth) {
      throw new BadRequestException("Add your name and date of birth first");
    }
    const types = CHECK_TYPES_FOR[kind];
    const rows = await latestRows(this.store, application.id, types);
    if (rows.length < types.length) throw new NotFoundException("This check is not one you chose");
    if (rows.some((row) => row.status !== "PENDING" && row.status !== "FAILED")) throw new ConflictException("This check is already running or done");

    if (kind === "FACE") {
      if (!selfie || !SELFIE_TYPES.has(selfie.mimetype) || selfie.size > 5 * 1024 * 1024) throw new BadRequestException("Take a clear photo (JPEG or PNG, up to 5 MB)");
      const photo = await this.aadhaarPhoto(application, client);
      // Stored with the case (deleted with it) so the check can run on any instance.
      await this.prisma.aadhaarPhoto.upsert({
        where: { applicationId: application.id },
        update: {},
        create: { applicationId: application.id, tenantId: application.tenantId, clientId: application.clientId, bytes: photo.buffer, contentType: photo.mimetype }
      });
      // The selfie becomes the card photo once face match passes; kept now, shown only on the card.
      await this.prisma.workerPhoto.upsert({
        where: { applicationId: application.id },
        update: { bytes: selfie.buffer, contentType: selfie.mimetype },
        create: { applicationId: application.id, tenantId: application.tenantId, clientId: application.clientId, bytes: selfie.buffer, contentType: selfie.mimetype }
      });
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

    for (const row of rows) await queueRow(this.store, this.queue, row, application.id, owner);
    await this.store.recalculateApplicationStatus(application.id, owner);
    return this.view(await this.reload(application.id, owner), owner);
  }

  /**
   * Reads a photo of the document for one chosen check and returns what to pre-fill. The worker
   * confirms or corrects it, then submits with POST checks/:kind. The photo is not kept.
   */
  async readDocument(worker: WorkerIdentity, client: ClientContext, kind: ReadableKind, photos: { front?: DocumentPhoto; back?: DocumentPhoto }) {
    const { application, owner } = await this.current(worker, client);
    this.requireConsent(application);
    if (!canReadDocument(kind)) throw new ServiceUnavailableException("Reading a photo is not available for this check. Type the details instead.");
    const rows = await latestRows(this.store, application.id, CHECK_TYPES_FOR[kind]);
    if (!rows.length) throw new NotFoundException("This check is not one you chose");
    if (rows.some((row) => row.status !== "PENDING" && row.status !== "FAILED")) throw new ConflictException("This check is already running or done");
    const spec = READABLE_DOCUMENTS[kind];
    const files: CheckFiles = {};
    for (const side of spec.files) {
      const photo = photos[side];
      const type = photo ? checkedFileType(photo.buffer, photo.mimetype, DOCUMENT_PHOTO_TYPES) : null;
      if (!photo || !type || photo.size > MAX_DOCUMENT_PHOTO_BYTES) {
        throw new BadRequestException(side === "back" ? "Add a photo of the back of the card too (JPEG, PNG or PDF, up to 5 MB)" : "Add a clear photo of the card (JPEG, PNG or PDF, up to 5 MB)");
      }
      files[spec.files.length === 1 ? "file" : side] = { buffer: photo.buffer, originalname: `${side}.${type === "application/pdf" ? "pdf" : type.split("/")[1]}`, mimetype: type };
    }
    let data: Record<string, unknown> | null | undefined;
    try {
      // Recorded against the case like any other provider call.
      const context = { tenantId: owner.tenantId, clientId: owner.clientId, apiKeyId: owner.apiKeyId, applicationId: application.id, operationKey: `ocr_${application.id}_${randomUUID()}` };
      data = (await providerCallContext.run(context, () => this.provider.executeCheck(spec.ocr, {}, files))).data;
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "PROVIDER_PRODUCT_DISABLED" || code === "PROVIDER_UNAVAILABLE") throw new ServiceUnavailableException("We could not read the photo right now. Type the details instead.");
      throw new UnprocessableEntityException("We could not read this photo. Take a clearer one, or type the details.");
    }
    const reading = readingFrom(kind, data);
    if (!Object.keys(reading.fields).length) throw new UnprocessableEntityException("We could not read this photo. Take a clearer one, or type the details.");
    const aadhaarName = application.data.personal.nameAsAadhaar;
    return { ...reading, nameMatchesAadhaar: reading.details.name && aadhaarName ? namesMatch(reading.details.name, aadhaarName) : null };
  }

  /** The Aadhaar photo is the reference image for face match. */
  private async aadhaarPhoto(application: ApplicationRecord, client: ClientContext) {
    const identity = application.data.identity;
    if (identity?.status !== "VERIFIED") throw new BadRequestException("Verify Aadhaar first; face match uses the Aadhaar photo");
    if (identity.source === "DIGILOCKER") {
      const stored = await this.prisma.aadhaarPhoto.findUnique({ where: { applicationId: application.id } });
      if (!stored) throw new BadRequestException("DigiLocker did not return a photo to match against");
      return { buffer: Buffer.from(stored.bytes), originalname: "aadhaar-photo.jpg", mimetype: stored.contentType };
    }
    const result = await this.aadhaar.result(identity.sessionId, client);
    const base64 = String(result.profile_image || "").replace(/^data:image\/\w+;base64,/, "");
    if (!base64) throw new BadRequestException("Aadhaar did not return a photo to match against");
    return { buffer: Buffer.from(base64, "base64"), originalname: "aadhaar-photo.jpg", mimetype: "image/jpeg" };
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

  /** Check types already paid for on this case: its bundle (or seat) and any extras bought. */
  private async paidTypes(applicationId: string): Promise<string[]> {
    const prepaid = await this.prisma.prepaidCase.findUnique({ where: { applicationId }, select: { coveredChecks: true } });
    return Array.isArray(prepaid?.coveredChecks) ? (prepaid.coveredChecks as string[]) : [];
  }

  private owner(client: ClientContext): ApplicationOwner {
    // A case opened through a partner's invite belongs to the partner's program, not the worker app's key.
    return { tenantId: client.tenantId, clientId: client.clientId, apiKeyId: client.actingForInvite ? undefined : client.apiKeyId };
  }

  /** What the worker app may see: states and the worker's own details, never raw provider data. */
  private async view(application: ApplicationRecord, owner: ApplicationOwner) {
    const data: ApplicationSchema = application.data;
    const [rows, paidTypes] = await Promise.all([this.store.getVerificationsForApplication(application.id, owner), this.paidTypes(application.id)]);
    const selected = data.selectedChecks ?? [];
    const courtReady = Boolean(data.personal.nameAsAadhaar && data.criminal?.fatherName && data.personal.submittedAddress);
    const paid = new Set(paidTypes);
    return {
      applicationId: application.id,
      cardNumber: application.card?.cardNumber ?? (await this.store.getCardNumber(application.id)) ?? null,
      status: application.status,
      catalog: (Object.keys(SELECTABLE_CHECKS) as SelectableCheck[]).map((check) => ({
        check,
        available: isSelectableAvailable(check),
        // The app may offer the camera: a photo of the document pre-fills the details.
        readable: canReadDocument(check),
        requires: SELECTABLE_CHECKS[check].requires ?? null,
        consent: SELECTABLE_CHECKS[check].consent,
        selected: selected.includes(check)
      })),
      selectedChecks: selected,
      // Invited by a company: it chose the checks and pays for them.
      sponsor: data.sponsor ? { partnerName: data.sponsor.partnerName, packageName: data.sponsor.packageName } : null,
      checksFixed: Boolean(data.sponsor),
      // Extras bought but not added yet (paid, then the app closed before consent): add them next.
      paidExtras: application.status === "DRAFT" ? [] : (Object.keys(SELECTABLE_CHECKS) as SelectableCheck[]).filter((check) => !selected.includes(check) && SELECTABLE_CHECKS[check].types.every((type) => paid.has(type))),
      consent: data.consent?.granted ? { textVersion: data.consent.textVersion, grantedAt: data.consent.grantedAt, items: data.consentItems ?? [] } : null,
      details: {
        source: data.identity?.status === "VERIFIED" ? "AADHAAR" : data.personal.nameAsAadhaar ? "WORKER" : null,
        fullName: data.personal.nameAsAadhaar || null,
        declaredName: data.personal.declaredName ?? null,
        dateOfBirth: data.personal.dateOfBirth || null,
        fatherName: data.criminal?.fatherName ?? null,
        address: data.personal.submittedAddress ?? null
      },
      identity: data.identity ? { source: data.identity.source, status: data.identity.status } : null,
      /** A later DigiLocker session that only shares documents. */
      documentsSession: data.digilockerDocuments ? { status: data.digilockerDocuments.status } : null,
      checks: rows.map((row) => ({
        id: row.id,
        type: row.type,
        status: row.status,
        needsInput: row.status === "PENDING" && (NEEDS_INPUT.has(row.type) || (row.type === "ECOURTS_SEARCH" && !courtReady)),
        canResubmit: row.status === "FAILED" && NEEDS_INPUT.has(row.type),
        reason: row.status === "FAILED" || row.status === "MANUAL_REVIEW" ? row.failureReason ?? null : null,
        // Set when the number came from a signed DigiLocker document rather than typed.
        source: data.documentSources?.[row.type] ?? null,
        updatedAt: row.updatedAt
      })),
      card: application.card ? { status: application.card.status, issuedAt: application.card.issuedAt, expiresAt: application.card.expiresAt } : null
    };
  }
}
