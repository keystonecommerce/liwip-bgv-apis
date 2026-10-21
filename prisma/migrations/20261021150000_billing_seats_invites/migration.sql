-- AlterTable
ALTER TABLE "VerificationPackage" ADD COLUMN     "createdById" TEXT,
ADD COLUMN     "listPricePaise" INTEGER,
ADD COLUMN     "module" TEXT NOT NULL DEFAULT 'PEOPLE',
ADD COLUMN     "publishedAt" TIMESTAMP(3),
ADD COLUMN     "role" TEXT,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'PUBLISHED';

-- CreateTable
CREATE TABLE "PackageAddOn" (
    "id" TEXT NOT NULL,
    "basePackageCode" TEXT NOT NULL,
    "addOnCode" TEXT NOT NULL,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PackageAddOn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiscountRule" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "tenantId" TEXT,
    "packageCode" TEXT,
    "minQty" INTEGER NOT NULL,
    "maxQty" INTEGER,
    "percentOffBps" INTEGER NOT NULL,
    "validFrom" TIMESTAMP(3),
    "validTo" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DiscountRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PartnerPrice" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "packageCode" TEXT NOT NULL,
    "unitPricePaise" INTEGER NOT NULL,
    "validFrom" TIMESTAMP(3),
    "validTo" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PartnerPrice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Quote" (
    "id" TEXT NOT NULL,
    "buyerType" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "clientId" TEXT,
    "applicationId" TEXT,
    "lines" JSONB NOT NULL,
    "subtotalPaise" INTEGER NOT NULL,
    "discountPaise" INTEGER NOT NULL,
    "taxablePaise" INTEGER NOT NULL,
    "cgstPaise" INTEGER NOT NULL,
    "sgstPaise" INTEGER NOT NULL,
    "igstPaise" INTEGER NOT NULL,
    "totalPaise" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Quote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "quoteId" TEXT NOT NULL,
    "buyerType" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "clientId" TEXT,
    "applicationId" TEXT,
    "createdById" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING_PAYMENT',
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "subtotalPaise" INTEGER NOT NULL,
    "discountPaise" INTEGER NOT NULL,
    "taxablePaise" INTEGER NOT NULL,
    "cgstPaise" INTEGER NOT NULL,
    "sgstPaise" INTEGER NOT NULL,
    "igstPaise" INTEGER NOT NULL,
    "totalPaise" INTEGER NOT NULL,
    "refundedPaise" INTEGER NOT NULL DEFAULT 0,
    "idempotencyKey" TEXT NOT NULL,
    "cfOrderId" TEXT,
    "paymentSessionId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderLine" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "packageId" TEXT NOT NULL,
    "packageCode" TEXT NOT NULL,
    "packageVersion" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitListPaise" INTEGER NOT NULL,
    "unitPricePaise" INTEGER NOT NULL,
    "addOns" JSONB NOT NULL,
    "discountRuleId" TEXT,
    "discountBps" INTEGER NOT NULL DEFAULT 0,
    "discountPaise" INTEGER NOT NULL DEFAULT 0,
    "lineTotalPaise" INTEGER NOT NULL,

    CONSTRAINT "OrderLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "cfPaymentId" TEXT,
    "status" TEXT NOT NULL,
    "amountPaise" INTEGER NOT NULL,
    "method" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentWebhookEvent" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "orderId" TEXT,
    "signatureValid" BOOLEAN NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "PaymentWebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Refund" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "amountPaise" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "cfRefundId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Refund_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invoice" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "buyerName" TEXT NOT NULL,
    "buyerGstin" TEXT,
    "buyerState" TEXT,
    "sellerState" TEXT NOT NULL,
    "sacCode" TEXT NOT NULL,
    "taxablePaise" INTEGER NOT NULL,
    "cgstPaise" INTEGER NOT NULL,
    "sgstPaise" INTEGER NOT NULL,
    "igstPaise" INTEGER NOT NULL,
    "totalPaise" INTEGER NOT NULL,
    "storageKey" TEXT,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceCounter" (
    "financialYear" TEXT NOT NULL,
    "next" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "InvoiceCounter_pkey" PRIMARY KEY ("financialYear")
);

-- CreateTable
CREATE TABLE "SeatLedger" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "packageCode" TEXT NOT NULL,
    "packageVersion" INTEGER NOT NULL,
    "delta" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "orderLineId" TEXT,
    "inviteId" TEXT,
    "reason" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SeatLedger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BulkUpload" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "packageCode" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "rowCount" INTEGER NOT NULL,
    "readyCount" INTEGER NOT NULL,
    "rejectedCount" INTEGER NOT NULL,
    "rows" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'VALIDATED',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "BulkUpload_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invite" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "uploadId" TEXT,
    "packageCode" TEXT NOT NULL,
    "packageVersion" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SENT',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "channel" TEXT,
    "messageId" TEXT,
    "deliveryStatus" TEXT,
    "applicationId" TEXT,
    "createdById" TEXT,
    "startedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Invite_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PackageAddOn_basePackageCode_addOnCode_key" ON "PackageAddOn"("basePackageCode", "addOnCode");

-- CreateIndex
CREATE INDEX "DiscountRule_scope_isActive_idx" ON "DiscountRule"("scope", "isActive");

-- CreateIndex
CREATE INDEX "DiscountRule_tenantId_isActive_idx" ON "DiscountRule"("tenantId", "isActive");

-- CreateIndex
CREATE INDEX "PartnerPrice_tenantId_packageCode_isActive_idx" ON "PartnerPrice"("tenantId", "packageCode", "isActive");

-- CreateIndex
CREATE INDEX "Quote_tenantId_createdAt_idx" ON "Quote"("tenantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Order_quoteId_key" ON "Order"("quoteId");

-- CreateIndex
CREATE INDEX "Order_tenantId_createdAt_idx" ON "Order"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "Order_status_expiresAt_idx" ON "Order"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Order_tenantId_idempotencyKey_key" ON "Order"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "OrderLine_orderId_idx" ON "OrderLine"("orderId");

-- CreateIndex
CREATE INDEX "OrderLine_tenantId_packageCode_idx" ON "OrderLine"("tenantId", "packageCode");

-- CreateIndex
CREATE INDEX "Payment_orderId_idx" ON "Payment"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_provider_cfPaymentId_key" ON "Payment"("provider", "cfPaymentId");

-- CreateIndex
CREATE INDEX "PaymentWebhookEvent_orderId_idx" ON "PaymentWebhookEvent"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentWebhookEvent_provider_idempotencyKey_key" ON "PaymentWebhookEvent"("provider", "idempotencyKey");

-- CreateIndex
CREATE INDEX "Refund_orderId_idx" ON "Refund"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_number_key" ON "Invoice"("number");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_orderId_key" ON "Invoice"("orderId");

-- CreateIndex
CREATE INDEX "Invoice_tenantId_issuedAt_idx" ON "Invoice"("tenantId", "issuedAt");

-- CreateIndex
CREATE INDEX "SeatLedger_tenantId_packageCode_idx" ON "SeatLedger"("tenantId", "packageCode");

-- CreateIndex
CREATE INDEX "SeatLedger_inviteId_idx" ON "SeatLedger"("inviteId");

-- CreateIndex
CREATE INDEX "BulkUpload_tenantId_createdAt_idx" ON "BulkUpload"("tenantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Invite_tokenHash_key" ON "Invite"("tokenHash");

-- CreateIndex
CREATE INDEX "Invite_tenantId_phone_status_idx" ON "Invite"("tenantId", "phone", "status");

-- CreateIndex
CREATE INDEX "Invite_status_expiresAt_idx" ON "Invite"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "VerificationPackage_code_status_idx" ON "VerificationPackage"("code", "status");

-- AddForeignKey
ALTER TABLE "DiscountRule" ADD CONSTRAINT "DiscountRule_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartnerPrice" ADD CONSTRAINT "PartnerPrice_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "Quote"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderLine" ADD CONSTRAINT "OrderLine_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderLine" ADD CONSTRAINT "OrderLine_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "VerificationPackage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeatLedger" ADD CONSTRAINT "SeatLedger_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BulkUpload" ADD CONSTRAINT "BulkUpload_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invite" ADD CONSTRAINT "Invite_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invite" ADD CONSTRAINT "Invite_uploadId_fkey" FOREIGN KEY ("uploadId") REFERENCES "BulkUpload"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Existing packages: price in paise, published state from isActive.
UPDATE "VerificationPackage" SET "listPricePaise" = "priceInr" * 100 WHERE "priceInr" IS NOT NULL AND "listPricePaise" IS NULL;
UPDATE "VerificationPackage" SET "status" = CASE WHEN "isActive" THEN 'PUBLISHED' ELSE 'RETIRED' END, "publishedAt" = COALESCE("publishedAt", "createdAt");

-- One published version per package code.
CREATE UNIQUE INDEX "VerificationPackage_one_published" ON "VerificationPackage"("code") WHERE "status" = 'PUBLISHED';

-- A partner rule names its partner; a global rule does not. Ranges are sane.
ALTER TABLE "DiscountRule" ADD CONSTRAINT "DiscountRule_scope_check" CHECK (("scope" = 'GLOBAL' AND "tenantId" IS NULL) OR ("scope" = 'PARTNER' AND "tenantId" IS NOT NULL));
ALTER TABLE "DiscountRule" ADD CONSTRAINT "DiscountRule_range_check" CHECK ("minQty" >= 1 AND ("maxQty" IS NULL OR "maxQty" >= "minQty") AND "percentOffBps" BETWEEN 1 AND 9000);
ALTER TABLE "PartnerPrice" ADD CONSTRAINT "PartnerPrice_price_check" CHECK ("unitPricePaise" >= 100);

-- Order codes are 10 characters from the unambiguous alphabet.
ALTER TABLE "Order" ADD CONSTRAINT "Order_code_check" CHECK ("id" ~ '^[2-9A-HJKMNP-Z]{10}$');
ALTER TABLE "OrderLine" ADD CONSTRAINT "OrderLine_quantity_check" CHECK ("quantity" BETWEEN 1 AND 100000);

-- One open invite per phone per partner.
CREATE UNIQUE INDEX "Invite_one_open_per_phone" ON "Invite"("tenantId", "phone") WHERE "status" IN ('SENT', 'STARTED');
