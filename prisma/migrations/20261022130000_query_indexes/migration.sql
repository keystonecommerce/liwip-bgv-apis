-- Indexes for the revenue report, refunds, invite lists, usage report and per-case reads.
CREATE INDEX "Order_status_paidAt_idx" ON "Order"("status", "paidAt");
CREATE INDEX "Refund_createdAt_idx" ON "Refund"("createdAt");
CREATE INDEX "Invite_tenantId_createdAt_idx" ON "Invite"("tenantId", "createdAt");
CREATE INDEX "Invite_uploadId_idx" ON "Invite"("uploadId");
CREATE INDEX "Verification_tenantId_clientId_completedAt_idx" ON "Verification"("tenantId", "clientId", "completedAt");
-- Per-case reads are ordered by createdAt; this index also serves lookups by applicationId alone.
DROP INDEX "Verification_applicationId_idx";
CREATE INDEX "Verification_applicationId_createdAt_idx" ON "Verification"("applicationId", "createdAt");
