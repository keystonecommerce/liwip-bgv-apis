-- AlterTable
ALTER TABLE "VerificationPackage" ADD COLUMN     "advertisedCheckCount" INTEGER,
ADD COLUMN     "displayOrder" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "priceInr" INTEGER,
ADD COLUMN     "targetWorkforce" TEXT;
