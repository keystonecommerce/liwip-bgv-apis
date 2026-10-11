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
import { DigiLockerService } from "../digilocker/digilocker.service";
import { PrismaService } from "../../common/database/prisma.service";
import { SurepassTransport } from "../../integrations/surepass/surepass.transport";
import { VerificationQueue } from "../verifications/verification.queue";
import { VerificationStore } from "../verifications/verification.repository";
import { DIGILOCKER_DOCUMENTS, sharedDocuments, type DigiLockerDocType, type SharedDocument } from "./digilocker-documents";
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
    @Inject(AadhaarOvseService) private readonly aadhaar: AadhaarOvseService,
    @Inject(DigiLockerService) private readonly digilocker: DigiLockerService,
    @Inject(SurepassTransport) private readonly surepass: SurepassTransport,
    @Inject(PrismaService) private readonly prisma: PrismaService
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
      criminal: { ...data.criminal, consent: data.criminal?.consent || needed.includes("court") }
    }));
    await this.store.addVerifications(application.id, added.flatMap((check) => SELECTABLE_CHECKS[check as SelectableCheck].types).map((type) => ({ type, status: "PENDING" as const })));
    await this.startReadyChecks(application.id, owner);
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
    // The signed request opens the official Aadhaar app directly; web_link is Surepass's hosted launcher.
    return { url: session.web_link, intentData: typeof session.intent_data === "string" ? session.intent_data : null };
  }

  /** Aadhaar through DigiLocker: a web page with mobile OTP, for when the Aadhaar app does not work. */
  async startDigiLocker(worker: WorkerIdentity, client: ClientContext) {
    const { application, owner } = await this.current(worker, client);
    this.requireConsent(application);
    if (!(await this.rowsFor(application.id, ["AADHAAR"])).length) throw new BadRequestException("Aadhaar is not one of your chosen checks");
    if (application.data.identity?.status === "VERIFIED") throw new ConflictException("Your Aadhaar is already verified");
    const session = await this.digilocker.initialize({ data: {
      signup_flow: true,
      auth_type: "web",
      aadhaar_xml: true,
      expiry_minutes: 10,
      redirect_url: process.env.WORKER_DIGILOCKER_RETURN_URL || undefined,
      prefill_options: { mobile_number: worker.phone.slice(2) }
    } }, client);
    await this.store.updateApplicationData(application.id, owner, (data) => ({
      ...data, identity: { source: "DIGILOCKER", sessionId: session.client_id, status: "PENDING" }
    }));
    return { url: session.url };
  }

  /** Called when the worker returns from the Aadhaar app or DigiLocker. Safe to call repeatedly. */
  async completeAadhaar(worker: WorkerIdentity, client: ClientContext) {
    const { application, owner } = await this.current(worker, client);
    const identity = application.data.identity;
    if (!identity) throw new BadRequestException("Start Aadhaar verification first");
    if (identity.status === "VERIFIED") return this.view(application, owner);
    if (identity.source === "DIGILOCKER") return this.completeDigiLocker(application, owner);
    // The app polls every few seconds; ask the provider at most every 10 seconds.
    if (identity.checkedAt && Date.now() - Date.parse(identity.checkedAt) < 10_000) return this.view(application, owner);
    await this.store.updateApplicationData(application.id, owner, (data) => ({ ...data, identity: { ...identity, checkedAt: new Date().toISOString() } }));
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
    if ((application.data.selectedChecks ?? []).includes("AADHAAR") && application.data.identity?.status !== "VERIFIED") {
      throw new BadRequestException("Verify your Aadhaar first");
    }
    if (!application.data.personal.nameAsAadhaar || !application.data.personal.dateOfBirth) {
      throw new BadRequestException("Add your name and date of birth first");
    }
    const types = CHECK_TYPES_FOR[kind];
    const rows = await this.rowsFor(application.id, types);
    if (rows.length < types.length) throw new NotFoundException("This check is not one you chose");
    if (rows.some((row) => row.status !== "PENDING" && row.status !== "FAILED")) throw new ConflictException("This check is already running or done");

    if (kind === "FACE") {
      if (!selfie || !SELFIE_TYPES.has(selfie.mimetype) || selfie.size > 5 * 1024 * 1024) throw new BadRequestException("Take a clear photo (JPEG or PNG, up to 5 MB)");
      const photo = await this.aadhaarPhoto(application, client);
      // Stored with the case (deleted with it) so the check can run on any instance.
      await this.prisma.aadhaarPhoto.upsert({
        where: { applicationId: application.id },
        update: {},
        create: { applicationId: application.id, bytes: photo.buffer, contentType: photo.mimetype }
      });
      // The selfie becomes the card photo once face match passes; kept now, shown only on the card.
      await this.prisma.workerPhoto.upsert({
        where: { applicationId: application.id },
        update: { bytes: selfie.buffer, contentType: selfie.mimetype },
        create: { applicationId: application.id, bytes: selfie.buffer, contentType: selfie.mimetype }
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

    for (const row of rows) await this.queueRow(row, application.id, owner);
    await this.store.recalculateApplicationStatus(application.id, owner);
    return this.view(await this.reload(application.id, owner), owner);
  }

  /** Asks DigiLocker at most every 10 seconds, then downloads the signed Aadhaar once. */
  private async completeDigiLocker(application: ApplicationRecord, owner: ApplicationOwner) {
    const identity = application.data.identity!;
    if (identity.checkedAt && Date.now() - Date.parse(identity.checkedAt) < 10_000) return this.view(application, owner);
    await this.store.updateApplicationData(application.id, owner, (data) => ({ ...data, identity: { ...identity, checkedAt: new Date().toISOString() } }));

    const id = encodeURIComponent(identity.sessionId);
    const status = (await this.surepass.request({ path: `/api/v1/digilocker/status/${id}`, method: "GET" })).body as { data?: { completed?: boolean; failed?: boolean; status?: string } } | null;
    const [row] = await this.rowsFor(application.id, ["AADHAAR"]);
    if (status?.data?.failed) {
      await this.store.updateApplicationData(application.id, owner, (data) => ({ ...data, identity: { ...identity, status: "FAILED" } }));
      if (row) await this.store.setResult(row.id, "FAILED", { failureCode: "DIGILOCKER_NOT_COMPLETED", failureReason: "DigiLocker was not completed. Try again." }, owner);
      await this.store.recalculateApplicationStatus(application.id, owner);
      return this.view(await this.reload(application.id, owner), owner);
    }
    if (!status?.data?.completed) return this.view(await this.reload(application.id, owner), owner);

    const download = (await this.surepass.request({ path: `/api/v1/digilocker/download-aadhaar/${id}`, method: "GET" })).body as { data?: { aadhaar_xml_data?: Record<string, unknown> } } | null;
    const aadhaar = download?.data?.aadhaar_xml_data ?? {};
    const text = (key: string) => (typeof aadhaar[key] === "string" ? String(aadhaar[key]).trim() : undefined);
    const fullName = text("full_name");
    const dateOfBirth = isoDate(text("dob"));
    if (!fullName || !dateOfBirth) throw new BadRequestException("DigiLocker did not return your Aadhaar name and date of birth. Try again.");
    const photo = text("profile_image")?.replace(/^data:image\/\w+;base64,/, "");
    if (photo) {
      const bytes = Buffer.from(photo, "base64");
      await this.prisma.aadhaarPhoto.upsert({
        where: { applicationId: application.id },
        update: { bytes, contentType: "image/jpeg" },
        create: { applicationId: application.id, bytes, contentType: "image/jpeg" }
      });
    }
    const careOf = text("care_of");
    const fatherName = text("father_name") || fatherFromCareOf(careOf);
    const fullAddress = text("full_address");
    await this.store.updateApplicationData(application.id, owner, (data) => ({
      ...data,
      identity: { ...identity, status: "VERIFIED", fullName, dateOfBirth, gender: text("gender"), address: fullAddress, pincode: text("zip"), careOf, verifiedAt: new Date().toISOString() },
      personal: { ...data.personal, nameAsAadhaar: fullName, dateOfBirth, gender: text("gender"), submittedAddress: fullAddress || data.personal.submittedAddress },
      criminal: { ...data.criminal, fatherName: data.criminal?.fatherName || fatherName }
    }));
    if (row) await this.store.setResult(row.id, "VERIFIED", { providerRequestId: identity.sessionId, result: { source: "DIGILOCKER", nameOnAadhaar: fullName } }, owner);
    await this.useSharedDocuments(application.id, owner, id);
    await this.startReadyChecks(application.id, owner);
    return this.view(await this.reload(application.id, owner), owner);
  }

  /**
   * Starts the PAN, licence and RC checks for documents the worker also ticked on DigiLocker's
   * consent screen, using the number from each document. Anything not shared stays a normal
   * step where the worker types the number. Never holds up Aadhaar.
   */
  private async useSharedDocuments(applicationId: string, owner: ApplicationOwner, sessionId: string) {
    let shared: SharedDocument[];
    try {
      shared = sharedDocuments((await this.surepass.request({ path: `/api/v1/digilocker/list-documents/${sessionId}`, method: "GET" })).body);
    } catch {
      return;
    }
    // Which documents were shared (not their numbers), for support.
    await this.store.updateApplicationData(applicationId, owner, (data) => ({
      ...data, identity: { ...data.identity!, sharedDocuments: shared.map(({ doctype, issuer }) => ({ doctype, issuer })) }
    }));
    for (const doc of shared) {
      const spec = DIGILOCKER_DOCUMENTS[doc.doctype as DigiLockerDocType];
      if (!spec || !doc.number) continue;
      const rows = await this.rowsFor(applicationId, CHECK_TYPES_FOR[spec.check]);
      if (!rows.length || rows.some((row) => row.status !== "PENDING")) continue;
      try {
        await this.store.updateApplicationData(applicationId, owner, (data) => applyCheckInput(spec.check, { [spec.input]: doc.number }, data));
      } catch {
        continue; // a number in a format we do not expect: the worker types it instead
      }
      for (const row of rows) await this.queueRow(row, applicationId, owner);
    }
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
        declaredName: data.personal.declaredName ?? null,
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
