-- CreateTable
CREATE TABLE "ApplicationDocument" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "documentType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING_UPLOAD',
    "bucket" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "originalFileName" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "declaredSizeBytes" INTEGER NOT NULL,
    "sizeBytes" INTEGER,
    "versionId" TEXT,
    "etag" TEXT,
    "checksumSha256" TEXT,
    "storageEncryption" TEXT,
    "kmsKeyArn" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "uploadedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApplicationDocument_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ApplicationDocument_bucket_objectKey_key" ON "ApplicationDocument"("bucket", "objectKey");

-- CreateIndex
CREATE INDEX "ApplicationDocument_tenantId_clientId_createdAt_idx" ON "ApplicationDocument"("tenantId", "clientId", "createdAt");

-- CreateIndex
CREATE INDEX "ApplicationDocument_applicationId_createdAt_idx" ON "ApplicationDocument"("applicationId", "createdAt");

-- CreateIndex
CREATE INDEX "ApplicationDocument_status_expiresAt_idx" ON "ApplicationDocument"("status", "expiresAt");

-- AddForeignKey
ALTER TABLE "ApplicationDocument" ADD CONSTRAINT "ApplicationDocument_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApplicationDocument" ADD CONSTRAINT "ApplicationDocument_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApplicationDocument" ADD CONSTRAINT "ApplicationDocument_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;
