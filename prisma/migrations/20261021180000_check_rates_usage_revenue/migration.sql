-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "statementId" TEXT,
ALTER COLUMN "orderId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "OrderLine" ADD COLUMN     "addOnPaise" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "packagePaise" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "CheckRate" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "checkType" TEXT NOT NULL,
    "unitPricePaise" INTEGER NOT NULL,
    "validFrom" TIMESTAMP(3),
    "validTo" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CheckRate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PrepaidCase" (
    "applicationId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "orderId" TEXT,
    "inviteId" TEXT,
    "packageCode" TEXT NOT NULL,
    "packageVersion" INTEGER NOT NULL,
    "coveredChecks" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PrepaidCase_pkey" PRIMARY KEY ("applicationId")
);

-- CreateTable
CREATE TABLE "UsageCharge" (
    "id" TEXT NOT NULL,
    "verificationId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "checkType" TEXT NOT NULL,
    "checkRateId" TEXT NOT NULL,
    "unitPricePaise" INTEGER NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "statementId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UsageCharge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UsageStatement" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ISSUED',
    "lines" JSONB NOT NULL,
    "checkCount" INTEGER NOT NULL,
    "taxablePaise" INTEGER NOT NULL,
    "cgstPaise" INTEGER NOT NULL,
    "sgstPaise" INTEGER NOT NULL,
    "igstPaise" INTEGER NOT NULL,
    "totalPaise" INTEGER NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "paidAt" TIMESTAMP(3),
    "paymentReference" TEXT,
    "createdById" TEXT,

    CONSTRAINT "UsageStatement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CheckRate_checkType_isActive_idx" ON "CheckRate"("checkType", "isActive");

-- CreateIndex
CREATE INDEX "CheckRate_tenantId_checkType_idx" ON "CheckRate"("tenantId", "checkType");

-- CreateIndex
CREATE INDEX "PrepaidCase_tenantId_idx" ON "PrepaidCase"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "UsageCharge_verificationId_key" ON "UsageCharge"("verificationId");

-- CreateIndex
CREATE INDEX "UsageCharge_tenantId_occurredAt_idx" ON "UsageCharge"("tenantId", "occurredAt");

-- CreateIndex
CREATE INDEX "UsageCharge_statementId_idx" ON "UsageCharge"("statementId");

-- CreateIndex
CREATE INDEX "UsageCharge_occurredAt_idx" ON "UsageCharge"("occurredAt");

-- CreateIndex
CREATE INDEX "UsageStatement_status_dueAt_idx" ON "UsageStatement"("status", "dueAt");

-- CreateIndex
CREATE UNIQUE INDEX "UsageStatement_tenantId_period_key" ON "UsageStatement"("tenantId", "period");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_statementId_key" ON "Invoice"("statementId");

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_statementId_fkey" FOREIGN KEY ("statementId") REFERENCES "UsageStatement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckRate" ADD CONSTRAINT "CheckRate_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrepaidCase" ADD CONSTRAINT "PrepaidCase_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageCharge" ADD CONSTRAINT "UsageCharge_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageCharge" ADD CONSTRAINT "UsageCharge_statementId_fkey" FOREIGN KEY ("statementId") REFERENCES "UsageStatement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageStatement" ADD CONSTRAINT "UsageStatement_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;



-- Existing order lines: split each line into its package sale and its add-on sale.
UPDATE "OrderLine" SET "packagePaise" = "unitPricePaise" * "quantity" - "discountPaise", "addOnPaise" = "lineTotalPaise" - ("unitPricePaise" * "quantity" - "discountPaise");

-- An invoice is for exactly one order or one usage statement.
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_source_check" CHECK (("orderId" IS NULL) <> ("statementId" IS NULL));
ALTER TABLE "OrderLine" ADD CONSTRAINT "OrderLine_split_check" CHECK ("packagePaise" >= 0 AND "addOnPaise" >= 0 AND "packagePaise" + "addOnPaise" = "lineTotalPaise");
ALTER TABLE "CheckRate" ADD CONSTRAINT "CheckRate_price_check" CHECK ("unitPricePaise" >= 100 AND ("validTo" IS NULL OR "validFrom" IS NULL OR "validTo" > "validFrom"));
ALTER TABLE "PrepaidCase" ADD CONSTRAINT "PrepaidCase_source_check" CHECK ("source" IN ('ORDER', 'SEAT'));
ALTER TABLE "UsageCharge" ADD CONSTRAINT "UsageCharge_price_check" CHECK ("unitPricePaise" >= 0);
ALTER TABLE "UsageStatement" ADD CONSTRAINT "UsageStatement_period_check" CHECK ("period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$' AND "status" IN ('ISSUED', 'PAID', 'VOID'));
