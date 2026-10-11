import type { ApplicationOwner, VerificationRecord, VerificationType } from "../../domain/verification.types";
import type { VerificationQueue } from "../verifications/verification.queue";
import type { VerificationStore } from "../verifications/verification.repository";

/** Latest row per type, in the order asked. */
export async function latestRows(store: VerificationStore, applicationId: string, types: VerificationType[]): Promise<VerificationRecord[]> {
  const rows = await store.getVerificationsForApplication(applicationId);
  return types.map((type) => rows.filter((row) => row.type === type).at(-1)).filter((row): row is VerificationRecord => Boolean(row));
}

/** Hands a check to the verification queue. */
export async function queueRow(store: VerificationStore, queue: VerificationQueue, row: VerificationRecord, applicationId: string, owner: ApplicationOwner) {
  await store.updateVerification(row.id, { status: "QUEUED", failureCode: null as unknown as string, failureReason: null as unknown as string }, owner);
  await queue.addVerificationJob({ verificationId: row.id, applicationId, type: row.type, inputAfterAttempt: row.attemptCount });
}

/** The court search runs on its own once name, father's name and address are known. */
export async function startReadyChecks(store: VerificationStore, queue: VerificationQueue, applicationId: string, owner: ApplicationOwner) {
  const application = await store.getApplication(applicationId, owner);
  if (!application) return;
  const { personal, criminal } = application.data;
  const courtReady = Boolean(personal.nameAsAadhaar && criminal?.fatherName && personal.submittedAddress);
  for (const row of await store.getVerificationsForApplication(applicationId, owner)) {
    if (row.type === "ECOURTS_SEARCH" && row.status === "PENDING" && courtReady) await queueRow(store, queue, row, applicationId, owner);
  }
  await store.recalculateApplicationStatus(applicationId, owner);
}
