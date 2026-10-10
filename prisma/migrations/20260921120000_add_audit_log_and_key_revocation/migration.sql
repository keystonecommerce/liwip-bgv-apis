-- AlterTable: key revocation timestamp
ALTER TABLE "ApiKey" ADD COLUMN "revokedAt" TIMESTAMP(3);

-- CreateTable: append-only partner audit trail
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "actorType" TEXT NOT NULL,
    "tenantId" TEXT,
    "tenantSlug" TEXT,
    "clientId" TEXT,
    "clientCode" TEXT,
    "apiKeyId" TEXT,
    "keyPrefix" TEXT,
    "action" TEXT NOT NULL,
    "method" TEXT,
    "path" TEXT,
    "statusCode" INTEGER,
    "resourceType" TEXT,
    "resourceId" TEXT,
    "scopeUsed" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "durationMs" INTEGER,
    "outcome" TEXT NOT NULL,
    "message" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AuditLog_tenantId_createdAt_idx" ON "AuditLog"("tenantId", "createdAt");
CREATE INDEX "AuditLog_clientId_createdAt_idx" ON "AuditLog"("clientId", "createdAt");
CREATE INDEX "AuditLog_apiKeyId_createdAt_idx" ON "AuditLog"("apiKeyId", "createdAt");
CREATE INDEX "AuditLog_action_createdAt_idx" ON "AuditLog"("action", "createdAt");
CREATE INDEX "AuditLog_outcome_createdAt_idx" ON "AuditLog"("outcome", "createdAt");
