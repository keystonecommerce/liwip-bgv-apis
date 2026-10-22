-- Aadhaar images are kept only after masking.
ALTER TABLE "ApplicationDocument" ADD COLUMN "maskedAt" TIMESTAMP(3);
