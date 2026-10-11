import { BadRequestException, Inject, Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import IORedis from "ioredis";
import { PrismaService } from "../../../common/database/prisma.service";
import { redisConnectionOptions } from "../../../config/redis";
import type { ApplicationOwner, ApplicationRecord, ApplicationSchema } from "../../../domain/verification.types";
import { SurepassTransport } from "../../../integrations/surepass/surepass.transport";
import { VerificationQueue } from "../../verifications/verification.queue";
import { VerificationStore } from "../../verifications/verification.repository";
import { latestRows, queueRow, startReadyChecks } from "../case-rows";
import { applyCheckInput, CHECK_TYPES_FOR, fatherFromCareOf, isoDate } from "../worker-case.inputs";
import { DigiLockerDocumentReader } from "./document-reader.service";
import { DIGILOCKER_DOCUMENTS, type DigiLockerDocType, type SharedDocument } from "./documents";

/** Provider status is asked at most this often, however many callers ask. */
const STATUS_EVERY_MS = 8_000;
/** One completion at a time per case: the worker's app and the background job may both try. */
const LOCK_SECONDS = 120;

export type CompletionOutcome = "done" | "waiting";

/** True while a DigiLocker session on the case still waits for the worker or for processing. */
export function digiLockerPending(data: ApplicationSchema): boolean {
  return (data.identity?.source === "DIGILOCKER" && data.identity.status === "PENDING") || data.digilockerDocuments?.status === "PENDING";
}

/**
 * Finishes a DigiLocker session once the worker has tapped Allow: Aadhaar (for an identity
 * session), then every shared PAN, licence and RC, whose numbers go to the usual registry
 * checks. It runs from the background job and from the worker's app alike, so a worker who
 * drops out after DigiLocker still finds their checks done when they come back.
 */
@Injectable()
export class DigiLockerCompletion implements OnModuleDestroy {
  private readonly logger = new Logger(DigiLockerCompletion.name);
  private readonly redis = new IORedis({ ...redisConnectionOptions(), lazyConnect: true, maxRetriesPerRequest: 1 });

  constructor(
    @Inject(VerificationStore) private readonly store: VerificationStore,
    @Inject(VerificationQueue) private readonly queue: VerificationQueue,
    @Inject(SurepassTransport) private readonly surepass: SurepassTransport,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(DigiLockerDocumentReader) private readonly documents: DigiLockerDocumentReader
  ) {}

  async run(applicationId: string, owner: ApplicationOwner): Promise<CompletionOutcome> {
    const lock = `liwip:digilocker-lock:${applicationId}`;
    if ((await this.redis.set(lock, "1", "EX", LOCK_SECONDS, "NX")) !== "OK") return "waiting";
    try {
      const application = await this.store.getApplication(applicationId, owner);
      if (!application) return "done";
      const { identity, digilockerDocuments } = application.data;
      if (identity?.source === "DIGILOCKER" && identity.status === "PENDING") return await this.completeIdentity(application, owner);
      if (digilockerDocuments?.status === "PENDING") return await this.completeDocuments(application, owner);
      return "done";
    } finally {
      await this.redis.del(lock).catch(() => undefined);
    }
  }

  async onModuleDestroy() {
    this.redis.disconnect();
  }

  /** "completed", "failed", or null while the worker has not finished (or asked too recently). */
  private async sessionStatus(sessionId: string, checkedAt: string | undefined, record: (at: string) => Promise<void>): Promise<"completed" | "failed" | null> {
    if (checkedAt && Date.now() - Date.parse(checkedAt) < STATUS_EVERY_MS) return null;
    await record(new Date().toISOString());
    const body = (await this.surepass.request({ path: `/api/v1/digilocker/status/${encodeURIComponent(sessionId)}`, method: "GET" })).body as { data?: { completed?: boolean; failed?: boolean } } | null;
    return body?.data?.failed ? "failed" : body?.data?.completed ? "completed" : null;
  }

  /** Aadhaar from DigiLocker, then any documents shared alongside it. */
  private async completeIdentity(application: ApplicationRecord, owner: ApplicationOwner): Promise<CompletionOutcome> {
    const identity = application.data.identity!;
    const status = await this.sessionStatus(identity.sessionId, identity.checkedAt, (at) =>
      this.store.updateApplicationData(application.id, owner, (data) => ({ ...data, identity: { ...data.identity!, checkedAt: at } })).then(() => undefined));
    const [row] = await latestRows(this.store, application.id, ["AADHAAR"]);
    if (status === "failed") {
      await this.store.updateApplicationData(application.id, owner, (data) => ({ ...data, identity: { ...data.identity!, status: "FAILED" } }));
      if (row) await this.store.setResult(row.id, "FAILED", { failureCode: "DIGILOCKER_NOT_COMPLETED", failureReason: "DigiLocker was not completed. Try again." }, owner);
      await this.store.recalculateApplicationStatus(application.id, owner);
      return "done";
    }
    if (status !== "completed") return "waiting";

    const download = (await this.surepass.request({ path: `/api/v1/digilocker/download-aadhaar/${encodeURIComponent(identity.sessionId)}`, method: "GET" })).body as { data?: { aadhaar_xml_data?: Record<string, unknown> } } | null;
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
      identity: { ...data.identity!, status: "VERIFIED", fullName, dateOfBirth, gender: text("gender"), address: fullAddress, pincode: text("zip"), careOf, verifiedAt: new Date().toISOString() },
      personal: { ...data.personal, nameAsAadhaar: fullName, dateOfBirth, gender: text("gender"), submittedAddress: fullAddress || data.personal.submittedAddress },
      criminal: { ...data.criminal, fatherName: data.criminal?.fatherName || fatherName }
    }));
    if (row) await this.store.setResult(row.id, "VERIFIED", { providerRequestId: identity.sessionId, result: { source: "DIGILOCKER", nameOnAadhaar: fullName } }, owner);
    await this.useSharedDocuments(application.id, owner, identity.sessionId);
    await startReadyChecks(this.store, this.queue, application.id, owner);
    return "done";
  }

  /** A later session, opened only to share documents for checks added after Aadhaar. */
  private async completeDocuments(application: ApplicationRecord, owner: ApplicationOwner): Promise<CompletionOutcome> {
    const session = application.data.digilockerDocuments!;
    const status = await this.sessionStatus(session.sessionId, session.checkedAt, (at) =>
      this.store.updateApplicationData(application.id, owner, (data) => ({ ...data, digilockerDocuments: { ...data.digilockerDocuments!, checkedAt: at } })).then(() => undefined));
    if (!status) return "waiting";
    if (status === "completed") await this.useSharedDocuments(application.id, owner, session.sessionId);
    await this.store.updateApplicationData(application.id, owner, (data) => ({
      ...data, digilockerDocuments: { ...data.digilockerDocuments!, status: status === "completed" ? "COMPLETED" : "FAILED" }
    }));
    await this.store.recalculateApplicationStatus(application.id, owner);
    return "done";
  }

  /**
   * Starts the PAN, licence and RC checks for documents the worker ticked on DigiLocker's
   * consent screen, using the number read from each document. The number still goes to the
   * registry check (Surepass), matched to Aadhaar as usual. Anything not shared, or not
   * readable, stays a normal step where the worker types the number. Never fails the session.
   */
  private async useSharedDocuments(applicationId: string, owner: ApplicationOwner, sessionId: string) {
    try {
      const shared = await this.documents.list(sessionId);
      if (!shared) return;
      // Which documents were shared (not their numbers), for support.
      await this.store.updateApplicationData(applicationId, owner, (data) => ({
        ...data, identity: data.identity ? { ...data.identity, sharedDocuments: shared.map(({ doctype, issuer }) => ({ doctype, issuer })) } : data.identity
      }));
      const application = await this.store.getApplication(applicationId, owner);
      const chosen = new Set(application?.data.selectedChecks ?? []);
      // One document per check: a worker with two vehicles shares two RCs, and the first one wins.
      const perCheck = new Map<string, SharedDocument>();
      for (const doc of shared) {
        const spec = DIGILOCKER_DOCUMENTS[doc.doctype as DigiLockerDocType];
        if (spec && chosen.has(spec.check) && !perCheck.has(spec.check)) perCheck.set(spec.check, doc);
      }
      // Access lasts minutes, so every shared document is read now, side by side.
      const read = await Promise.all([...perCheck.values()].map(async (doc) => {
        const spec = DIGILOCKER_DOCUMENTS[doc.doctype as DigiLockerDocType];
        const rows = await latestRows(this.store, applicationId, CHECK_TYPES_FOR[spec.check]);
        if (!rows.length || rows.some((row) => row.status !== "PENDING" && row.status !== "FAILED")) return null;
        const found = await this.documents.number(sessionId, doc);
        return found ? { spec, rows, found } : null;
      }));
      for (const item of read) {
        if (!item) continue;
        const { spec, rows, found } = item;
        try {
          await this.store.updateApplicationData(applicationId, owner, (current) => ({
            ...applyCheckInput(spec.check, { [spec.input]: found.number }, current),
            documentSources: { ...current.documentSources, [spec.check]: { source: "DIGILOCKER", signedBy: found.signedBy, signedAt: found.signedAt } }
          }));
        } catch {
          continue; // a number in a format we do not expect: the worker types it instead
        }
        for (const row of rows) await queueRow(this.store, this.queue, row, applicationId, owner);
      }
    } catch (error) {
      this.logger.warn(`Could not use shared DigiLocker documents: ${error instanceof Error ? error.name : "unknown error"}`);
    }
  }
}
