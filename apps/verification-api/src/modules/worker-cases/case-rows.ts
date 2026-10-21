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

/**
 * Checks that need no input of their own: the court search once name, father's name and
 * address are known, and the challan search once the RC check has found the vehicle.
 */
export async function startReadyChecks(store: VerificationStore, queue: VerificationQueue, applicationId: string, owner: ApplicationOwner) {
  const application = await store.getApplication(applicationId, owner);
  if (!application) return;
  const { personal, criminal } = application.data;
  const courtReady = Boolean(personal.nameAsAadhaar && criminal?.fatherName && personal.submittedAddress);
  const rows = await store.getVerificationsForApplication(applicationId, owner);
  const rc = rows.filter((row) => row.type === "RC_V2").at(-1);
  // Only a vehicle number the RC registry found, so a mistyped number is not searched (and billed) again.
  const challanReady = Boolean(application.data.vehicle?.registrationNumber && (rc?.status === "VERIFIED" || rc?.status === "MANUAL_REVIEW"));
  for (const row of rows) {
    if (row.type === "ECOURTS_SEARCH" && row.status === "PENDING" && courtReady) await queueRow(store, queue, row, applicationId, owner);
    if (row.type === "VEHICLE_CHALLAN" && row.status === "PENDING" && challanReady) await queueRow(store, queue, row, applicationId, owner);
  }
  await store.recalculateApplicationStatus(applicationId, owner);
}
