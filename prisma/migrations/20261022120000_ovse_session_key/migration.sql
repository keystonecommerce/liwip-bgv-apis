-- Bind each Aadhaar OVSE session to the API key that started it.
ALTER TABLE "AadhaarOvseSession" ADD COLUMN "apiKeyId" TEXT;
