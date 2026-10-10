-- Photo from a DigiLocker-verified Aadhaar, kept for face match.
CREATE TABLE "AadhaarPhoto" (
    "applicationId" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "bytes" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AadhaarPhoto_pkey" PRIMARY KEY ("applicationId")
);

ALTER TABLE "AadhaarPhoto" ADD CONSTRAINT "AadhaarPhoto_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;
