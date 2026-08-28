CREATE TABLE "VerificationCard" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "cardNumber" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VerificationCard_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "VerificationCard_applicationId_key" ON "VerificationCard"("applicationId");
CREATE UNIQUE INDEX "VerificationCard_cardNumber_key" ON "VerificationCard"("cardNumber");
CREATE UNIQUE INDEX "VerificationCard_publicId_key" ON "VerificationCard"("publicId");
CREATE INDEX "VerificationCard_tenantId_clientId_issuedAt_idx" ON "VerificationCard"("tenantId", "clientId", "issuedAt");
CREATE INDEX "VerificationCard_status_expiresAt_idx" ON "VerificationCard"("status", "expiresAt");

ALTER TABLE "VerificationCard"
ADD CONSTRAINT "VerificationCard_applicationId_fkey"
FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;
