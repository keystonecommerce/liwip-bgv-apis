-- Worker self-verification: a worker opens their own case after OTP.
ALTER TABLE "Application" ADD COLUMN "workerPhone" TEXT;
ALTER TABLE "Application" ADD COLUMN "cardNumber" TEXT;

CREATE UNIQUE INDEX "Application_cardNumber_key" ON "Application"("cardNumber");
CREATE INDEX "Application_clientId_workerPhone_idx" ON "Application"("clientId", "workerPhone");

-- At most one open draft per worker per platform, so two tabs cannot open two cases.
CREATE UNIQUE INDEX "Application_one_draft_per_worker" ON "Application"("clientId", "workerPhone") WHERE "status" = 'DRAFT';
