-- CreateTable: per-verification billing/metering ledger
CREATE TABLE "UsageEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "verificationId" TEXT NOT NULL,
    "checkType" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "billable" BOOLEAN NOT NULL,
    "provider" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UsageEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UsageEvent_verificationId_key" ON "UsageEvent"("verificationId");
CREATE INDEX "UsageEvent_tenantId_createdAt_idx" ON "UsageEvent"("tenantId", "createdAt");
CREATE INDEX "UsageEvent_clientId_createdAt_idx" ON "UsageEvent"("clientId", "createdAt");
CREATE INDEX "UsageEvent_billable_createdAt_idx" ON "UsageEvent"("billable", "createdAt");
CREATE INDEX "UsageEvent_checkType_idx" ON "UsageEvent"("checkType");
