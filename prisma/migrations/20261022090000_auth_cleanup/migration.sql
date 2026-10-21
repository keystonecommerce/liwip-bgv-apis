-- Auth cleanup: one staff login. The legacy password login and its portal role are gone;
-- staff access comes only from role bindings. Field tasks belong to a vendor; sessions record
-- when the person last confirmed it is them (powerful actions need that to be recent).

-- DropIndex
DROP INDEX "PortalUser_clientId_role_status_idx";

-- DropIndex
DROP INDEX "PortalUser_role_status_idx";

-- DropIndex
DROP INDEX "PortalUser_tenantId_role_status_idx";

-- AlterTable
ALTER TABLE "FieldTask" ADD COLUMN     "vendorId" TEXT;

-- AlterTable
ALTER TABLE "PortalUser" DROP COLUMN "passwordHash",
DROP COLUMN "role";

-- AlterTable
ALTER TABLE "StaffSession" ADD COLUMN     "verifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateIndex
CREATE INDEX "FieldTask_vendorId_status_idx" ON "FieldTask"("vendorId", "status");

-- CreateIndex
CREATE INDEX "PortalUser_tenantId_status_idx" ON "PortalUser"("tenantId", "status");

-- CreateIndex
CREATE INDEX "PortalUser_clientId_status_idx" ON "PortalUser"("clientId", "status");

-- AddForeignKey
ALTER TABLE "FieldTask" ADD CONSTRAINT "FieldTask_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

