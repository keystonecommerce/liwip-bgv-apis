-- Admin access layer: staff accounts with role bindings, email OTP and passkey sessions,
-- partner profiles and programs, vendors, verifier access, partner relationship end, and
-- direct tenant/client columns on child tables so scoped queries filter them uniformly.

-- Partners (Tenant) and programs (Client)
ALTER TABLE "Tenant"
  ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'PARTNER',
  ADD COLUMN "legalName" TEXT,
  ADD COLUMN "gstin" TEXT,
  ADD COLUMN "address" JSONB,
  ADD COLUMN "contacts" JSONB,
  ADD COLUMN "logoUrl" TEXT,
  ADD COLUMN "disabledAt" TIMESTAMP(3);
ALTER TABLE "Tenant" ADD CONSTRAINT "Tenant_kind_check" CHECK ("kind" IN ('PARTNER', 'DIRECT'));

ALTER TABLE "Client"
  ADD COLUMN "corporateCode" TEXT,
  ADD COLUMN "description" TEXT,
  ADD COLUMN "disabledAt" TIMESTAMP(3);
CREATE UNIQUE INDEX "Client_corporateCode_key" ON "Client"("corporateCode");

-- Partner relationship end
ALTER TABLE "Application"
  ADD COLUMN "relationshipStatus" TEXT NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN "relationshipEndedAt" TIMESTAMP(3),
  ADD COLUMN "relationshipEndReason" TEXT,
  ADD COLUMN "relationshipEndStatus" TEXT,
  ADD COLUMN "relationshipSnapshot" JSONB,
  ADD COLUMN "relationshipEndedById" TEXT;
ALTER TABLE "Application" ADD CONSTRAINT "Application_relationship_check"
  CHECK (("relationshipStatus" = 'ACTIVE' AND "relationshipEndedAt" IS NULL)
      OR ("relationshipStatus" = 'ENDED' AND "relationshipEndedAt" IS NOT NULL AND "relationshipSnapshot" IS NOT NULL));
CREATE INDEX "Application_tenantId_relationshipStatus_idx" ON "Application"("tenantId", "relationshipStatus");

-- Staff accounts: passwords and the legacy role become optional (legacy portal login only).
ALTER TABLE "PortalUser"
  ALTER COLUMN "passwordHash" DROP NOT NULL,
  ALTER COLUMN "role" DROP NOT NULL,
  ADD COLUMN "sessionVersion" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "invitedById" TEXT;

-- Audit: who (staff account) and structured details.
ALTER TABLE "AuditLog" ADD COLUMN "actorUserId" TEXT, ADD COLUMN "metadata" JSONB;
CREATE INDEX "AuditLog_actorUserId_createdAt_idx" ON "AuditLog"("actorUserId", "createdAt");
CREATE INDEX "AuditLog_resourceId_createdAt_idx" ON "AuditLog"("resourceId", "createdAt");

-- Verification: direct ownership, backfilled from the application.
ALTER TABLE "Verification" ADD COLUMN "tenantId" TEXT, ADD COLUMN "clientId" TEXT;
UPDATE "Verification" v SET "tenantId" = a."tenantId", "clientId" = a."clientId" FROM "Application" a WHERE a."id" = v."applicationId";
ALTER TABLE "Verification" ALTER COLUMN "tenantId" SET NOT NULL, ALTER COLUMN "clientId" SET NOT NULL;
ALTER TABLE "Verification" DROP CONSTRAINT "Verification_applicationId_fkey";
ALTER TABLE "Verification" ADD CONSTRAINT "Verification_application_owner_fkey" FOREIGN KEY ("applicationId", "tenantId", "clientId") REFERENCES "Application"("id", "tenantId", "clientId") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "Verification_tenantId_clientId_type_idx" ON "Verification"("tenantId", "clientId", "type");

-- Photos: direct ownership, backfilled from the application.
ALTER TABLE "AadhaarPhoto" ADD COLUMN "tenantId" TEXT, ADD COLUMN "clientId" TEXT;
UPDATE "AadhaarPhoto" p SET "tenantId" = a."tenantId", "clientId" = a."clientId" FROM "Application" a WHERE a."id" = p."applicationId";
ALTER TABLE "AadhaarPhoto" ALTER COLUMN "tenantId" SET NOT NULL, ALTER COLUMN "clientId" SET NOT NULL;
ALTER TABLE "AadhaarPhoto" DROP CONSTRAINT "AadhaarPhoto_applicationId_fkey";
CREATE UNIQUE INDEX "AadhaarPhoto_applicationId_tenantId_clientId_key" ON "AadhaarPhoto"("applicationId", "tenantId", "clientId");
ALTER TABLE "AadhaarPhoto" ADD CONSTRAINT "AadhaarPhoto_application_owner_fkey" FOREIGN KEY ("applicationId", "tenantId", "clientId") REFERENCES "Application"("id", "tenantId", "clientId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "WorkerPhoto" ADD COLUMN "tenantId" TEXT, ADD COLUMN "clientId" TEXT;
UPDATE "WorkerPhoto" p SET "tenantId" = a."tenantId", "clientId" = a."clientId" FROM "Application" a WHERE a."id" = p."applicationId";
ALTER TABLE "WorkerPhoto" ALTER COLUMN "tenantId" SET NOT NULL, ALTER COLUMN "clientId" SET NOT NULL;
ALTER TABLE "WorkerPhoto" DROP CONSTRAINT "WorkerPhoto_applicationId_fkey";
CREATE UNIQUE INDEX "WorkerPhoto_applicationId_tenantId_clientId_key" ON "WorkerPhoto"("applicationId", "tenantId", "clientId");
ALTER TABLE "WorkerPhoto" ADD CONSTRAINT "WorkerPhoto_application_owner_fkey" FOREIGN KEY ("applicationId", "tenantId", "clientId") REFERENCES "Application"("id", "tenantId", "clientId") ON DELETE CASCADE ON UPDATE CASCADE;

-- Card scans: card owner columns (backfilled) and who looked the card up.
CREATE UNIQUE INDEX "VerificationCard_id_tenantId_clientId_key" ON "VerificationCard"("id", "tenantId", "clientId");
ALTER TABLE "CardScan"
  ADD COLUMN "tenantId" TEXT,
  ADD COLUMN "clientId" TEXT,
  ADD COLUMN "viewerType" TEXT NOT NULL DEFAULT 'PUBLIC',
  ADD COLUMN "viewerUserId" TEXT,
  ADD COLUMN "viewerTenantId" TEXT,
  ADD COLUMN "view" TEXT NOT NULL DEFAULT 'PUBLIC';
UPDATE "CardScan" s SET "tenantId" = c."tenantId", "clientId" = c."clientId" FROM "VerificationCard" c WHERE c."id" = s."cardId";
ALTER TABLE "CardScan" ALTER COLUMN "tenantId" SET NOT NULL, ALTER COLUMN "clientId" SET NOT NULL;
ALTER TABLE "CardScan" DROP CONSTRAINT "CardScan_cardId_fkey";
ALTER TABLE "CardScan" ADD CONSTRAINT "CardScan_card_owner_fkey" FOREIGN KEY ("cardId", "tenantId", "clientId") REFERENCES "VerificationCard"("id", "tenantId", "clientId") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "CardScan_tenantId_scannedAt_idx" ON "CardScan"("tenantId", "scannedAt");
CREATE INDEX "CardScan_viewerUserId_scannedAt_idx" ON "CardScan"("viewerUserId", "scannedAt");

-- Vendors
CREATE TABLE "Vendor" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "contacts" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Vendor_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Vendor_slug_key" ON "Vendor"("slug");
CREATE INDEX "Vendor_status_idx" ON "Vendor"("status");

-- Role bindings: the only source of admin access.
CREATE TABLE "StaffRoleBinding" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "roleKey" TEXT NOT NULL,
    "scopeType" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "tenantId" TEXT,
    "vendorId" TEXT,
    "grantedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StaffRoleBinding_pkey" PRIMARY KEY ("id"),
    -- The scope columns must agree with the scope type, so a binding can never be ambiguous.
    CONSTRAINT "StaffRoleBinding_scope_check" CHECK (
      ("scopeType" = 'GLOBAL' AND "tenantId" IS NULL AND "vendorId" IS NULL AND "scopeKey" = 'GLOBAL')
      OR ("scopeType" = 'PARTNER' AND "tenantId" IS NOT NULL AND "vendorId" IS NULL AND "scopeKey" = 'partner:' || "tenantId")
      OR ("scopeType" = 'VENDOR' AND "vendorId" IS NOT NULL AND "tenantId" IS NULL AND "scopeKey" = 'vendor:' || "vendorId")
    )
);
CREATE UNIQUE INDEX "StaffRoleBinding_userId_roleKey_scopeKey_key" ON "StaffRoleBinding"("userId", "roleKey", "scopeKey");
CREATE INDEX "StaffRoleBinding_tenantId_roleKey_idx" ON "StaffRoleBinding"("tenantId", "roleKey");
CREATE INDEX "StaffRoleBinding_vendorId_roleKey_idx" ON "StaffRoleBinding"("vendorId", "roleKey");
CREATE INDEX "StaffRoleBinding_userId_idx" ON "StaffRoleBinding"("userId");
ALTER TABLE "StaffRoleBinding" ADD CONSTRAINT "StaffRoleBinding_userId_fkey" FOREIGN KEY ("userId") REFERENCES "PortalUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StaffRoleBinding" ADD CONSTRAINT "StaffRoleBinding_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StaffRoleBinding" ADD CONSTRAINT "StaffRoleBinding_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Existing corporate and support portal accounts keep equivalent access in the admin panel.
-- Field agents get none until they are bound to a vendor.
INSERT INTO "StaffRoleBinding" ("id", "userId", "roleKey", "scopeType", "scopeKey", "tenantId")
SELECT 'binding_' || md5(u."id" || ':PARTNER_ADMIN'), u."id", 'PARTNER_ADMIN', 'PARTNER', 'partner:' || u."tenantId", u."tenantId"
FROM "PortalUser" u WHERE u."role" = 'CORPORATE_ADMIN' AND u."tenantId" IS NOT NULL;
INSERT INTO "StaffRoleBinding" ("id", "userId", "roleKey", "scopeType", "scopeKey", "tenantId")
SELECT 'binding_' || md5(u."id" || ':PARTNER_OPERATOR'), u."id", 'PARTNER_OPERATOR', 'PARTNER', 'partner:' || u."tenantId", u."tenantId"
FROM "PortalUser" u WHERE u."role" = 'CORPORATE_OPERATOR' AND u."tenantId" IS NOT NULL;
INSERT INTO "StaffRoleBinding" ("id", "userId", "roleKey", "scopeType", "scopeKey")
SELECT 'binding_' || md5(u."id" || ':KEYSTONE_READ_ONLY'), u."id", 'KEYSTONE_READ_ONLY', 'GLOBAL', 'GLOBAL'
FROM "PortalUser" u WHERE u."role" = 'LIWIP_SUPPORT';

-- Email OTP, sessions, passkeys
CREATE TABLE "StaffOtp" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "ipHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StaffOtp_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "StaffOtp_email_createdAt_idx" ON "StaffOtp"("email", "createdAt");
CREATE INDEX "StaffOtp_expiresAt_idx" ON "StaffOtp"("expiresAt");

CREATE TABLE "StaffSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "sessionVersion" INTEGER NOT NULL,
    "authMethod" TEXT NOT NULL,
    "ipHash" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    CONSTRAINT "StaffSession_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "StaffSession_tokenHash_key" ON "StaffSession"("tokenHash");
CREATE INDEX "StaffSession_userId_createdAt_idx" ON "StaffSession"("userId", "createdAt");
CREATE INDEX "StaffSession_expiresAt_idx" ON "StaffSession"("expiresAt");
ALTER TABLE "StaffSession" ADD CONSTRAINT "StaffSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "PortalUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "StaffPasskey" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "rpId" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "publicKey" BYTEA NOT NULL,
    "counter" BIGINT NOT NULL DEFAULT 0,
    "transports" JSONB,
    "deviceType" TEXT,
    "backedUp" BOOLEAN NOT NULL DEFAULT false,
    "name" TEXT NOT NULL DEFAULT 'Passkey',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),
    CONSTRAINT "StaffPasskey_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "StaffPasskey_credentialId_key" ON "StaffPasskey"("credentialId");
CREATE INDEX "StaffPasskey_userId_idx" ON "StaffPasskey"("userId");
ALTER TABLE "StaffPasskey" ADD CONSTRAINT "StaffPasskey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "PortalUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "StaffAuthChallenge" (
    "id" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "userId" TEXT,
    "rpId" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "challenge" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StaffAuthChallenge_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "StaffAuthChallenge_expiresAt_idx" ON "StaffAuthChallenge"("expiresAt");

-- Verifier access
CREATE TABLE "VerifierAccess" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "organisation" TEXT,
    "purpose" TEXT,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revokedById" TEXT,
    "grantedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "VerifierAccess_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "VerifierAccess_level_check" CHECK ("level" IN ('SCOPED', 'UNIVERSAL'))
);
CREATE UNIQUE INDEX "VerifierAccess_userId_key" ON "VerifierAccess"("userId");
ALTER TABLE "VerifierAccess" ADD CONSTRAINT "VerifierAccess_userId_fkey" FOREIGN KEY ("userId") REFERENCES "PortalUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "VerifierCardGrant" (
    "id" TEXT NOT NULL,
    "verifierAccessId" TEXT NOT NULL,
    "cardId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "grantedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "VerifierCardGrant_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "VerifierCardGrant_source_check" CHECK ("source" IN ('GRANTED', 'SCANNED'))
);
CREATE UNIQUE INDEX "VerifierCardGrant_verifierAccessId_cardId_key" ON "VerifierCardGrant"("verifierAccessId", "cardId");
CREATE INDEX "VerifierCardGrant_cardId_idx" ON "VerifierCardGrant"("cardId");
ALTER TABLE "VerifierCardGrant" ADD CONSTRAINT "VerifierCardGrant_verifierAccessId_fkey" FOREIGN KEY ("verifierAccessId") REFERENCES "VerifierAccess"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VerifierCardGrant" ADD CONSTRAINT "VerifierCardGrant_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "VerificationCard"("id") ON DELETE CASCADE ON UPDATE CASCADE;
