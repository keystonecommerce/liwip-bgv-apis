-- Custom bundles: a partner's own package, priced by Keystone on request, sold only to them.
ALTER TABLE "VerificationPackage" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "VerificationPackage" ADD COLUMN "maxSeatsPerOrder" INTEGER;
CREATE INDEX "VerificationPackage_tenantId_idx" ON "VerificationPackage"("tenantId");

CREATE TABLE "BundleRequest" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "checks" JSONB NOT NULL,
  "expectedSeats" INTEGER,
  "note" TEXT,
  "status" TEXT NOT NULL DEFAULT 'REQUESTED',
  "requestedById" TEXT NOT NULL,
  "unitPricePaise" INTEGER,
  "maxSeatsPerOrder" INTEGER,
  "priceValidUntil" TIMESTAMP(3),
  "replyNote" TEXT,
  "pricedById" TEXT,
  "pricedAt" TIMESTAMP(3),
  "closedBy" TEXT,
  "closedAt" TIMESTAMP(3),
  "acceptedById" TEXT,
  "acceptedAt" TIMESTAMP(3),
  "packageId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BundleRequest_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "BundleRequest_packageId_key" ON "BundleRequest"("packageId");
CREATE INDEX "BundleRequest_tenantId_createdAt_idx" ON "BundleRequest"("tenantId", "createdAt");
CREATE INDEX "BundleRequest_status_createdAt_idx" ON "BundleRequest"("status", "createdAt");
ALTER TABLE "BundleRequest" ADD CONSTRAINT "BundleRequest_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "CheckCost" (
  "checkType" TEXT NOT NULL,
  "unitCostPaise" INTEGER NOT NULL,
  "note" TEXT,
  "updatedById" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CheckCost_pkey" PRIMARY KEY ("checkType")
);
