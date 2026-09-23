-- CreateTable
CREATE TABLE "FieldTask" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "verificationId" TEXT NOT NULL,
    "assignedToUserId" TEXT,
    "taskType" TEXT NOT NULL DEFAULT 'ADDRESS_VERIFICATION',
    "status" TEXT NOT NULL DEFAULT 'PENDING_ASSIGNMENT',
    "workerName" TEXT NOT NULL,
    "addressText" TEXT NOT NULL,
    "instructions" TEXT,
    "dueAt" TIMESTAMP(3),
    "outcome" TEXT,
    "notes" TEXT,
    "rejectionReason" TEXT,
    "arrivedAt" TIMESTAMP(3),
    "arriveLatitude" DOUBLE PRECISION,
    "arriveLongitude" DOUBLE PRECISION,
    "acceptedAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FieldTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FieldEvidence" (
    "id" TEXT NOT NULL,
    "fieldTaskId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING_UPLOAD',
    "bucket" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "originalFileName" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "declaredSizeBytes" INTEGER NOT NULL,
    "sizeBytes" INTEGER,
    "capturedLatitude" DOUBLE PRECISION,
    "capturedLongitude" DOUBLE PRECISION,
    "capturedAt" TIMESTAMP(3),
    "uploadedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FieldEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FieldTask_verificationId_key" ON "FieldTask"("verificationId");

-- CreateIndex
CREATE INDEX "FieldTask_assignedToUserId_status_idx" ON "FieldTask"("assignedToUserId", "status");

-- CreateIndex
CREATE INDEX "FieldTask_tenantId_clientId_status_idx" ON "FieldTask"("tenantId", "clientId", "status");

-- CreateIndex
CREATE INDEX "FieldTask_status_dueAt_idx" ON "FieldTask"("status", "dueAt");

-- CreateIndex
CREATE UNIQUE INDEX "FieldEvidence_bucket_objectKey_key" ON "FieldEvidence"("bucket", "objectKey");

-- CreateIndex
CREATE INDEX "FieldEvidence_fieldTaskId_createdAt_idx" ON "FieldEvidence"("fieldTaskId", "createdAt");

-- AddForeignKey
ALTER TABLE "FieldTask" ADD CONSTRAINT "FieldTask_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FieldTask" ADD CONSTRAINT "FieldTask_verificationId_fkey" FOREIGN KEY ("verificationId") REFERENCES "Verification"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FieldTask" ADD CONSTRAINT "FieldTask_assignedToUserId_fkey" FOREIGN KEY ("assignedToUserId") REFERENCES "PortalUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FieldEvidence" ADD CONSTRAINT "FieldEvidence_fieldTaskId_fkey" FOREIGN KEY ("fieldTaskId") REFERENCES "FieldTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;
