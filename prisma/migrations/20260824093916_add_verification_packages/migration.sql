-- AlterTable
ALTER TABLE "Application" ADD COLUMN     "packageId" TEXT;

-- CreateTable
CREATE TABLE "VerificationPackage" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'BASE',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "checks" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VerificationPackage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VerificationPackage_code_isActive_idx" ON "VerificationPackage"("code", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationPackage_code_version_key" ON "VerificationPackage"("code", "version");

-- CreateIndex
CREATE INDEX "Application_packageId_idx" ON "Application"("packageId");

-- AddForeignKey
ALTER TABLE "Application" ADD CONSTRAINT "Application_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "VerificationPackage"("id") ON DELETE SET NULL ON UPDATE CASCADE;
