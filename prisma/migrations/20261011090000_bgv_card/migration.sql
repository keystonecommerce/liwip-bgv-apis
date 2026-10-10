-- Liwip BGV Card: the worker's face-matched photo and a log of card checks.
CREATE TABLE "WorkerPhoto" (
    "applicationId" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "bytes" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkerPhoto_pkey" PRIMARY KEY ("applicationId")
);

CREATE TABLE "CardScan" (
    "id" TEXT NOT NULL,
    "cardId" TEXT NOT NULL,
    "via" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "ipHash" TEXT NOT NULL,
    "scannedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CardScan_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CardScan_cardId_scannedAt_idx" ON "CardScan"("cardId", "scannedAt");

ALTER TABLE "WorkerPhoto" ADD CONSTRAINT "WorkerPhoto_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CardScan" ADD CONSTRAINT "CardScan_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "VerificationCard"("id") ON DELETE CASCADE ON UPDATE CASCADE;
