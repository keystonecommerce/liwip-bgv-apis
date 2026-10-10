-- Worker passkeys (WebAuthn) for signing in without OTP.
CREATE TABLE "WorkerPasskey" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "workerPhone" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "publicKey" BYTEA NOT NULL,
    "counter" INTEGER NOT NULL DEFAULT 0,
    "transports" JSONB,
    "deviceType" TEXT,
    "backedUp" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "WorkerPasskey_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WorkerPasskey_credentialId_key" ON "WorkerPasskey"("credentialId");
CREATE INDEX "WorkerPasskey_tenantId_clientId_workerPhone_idx" ON "WorkerPasskey"("tenantId", "clientId", "workerPhone");
