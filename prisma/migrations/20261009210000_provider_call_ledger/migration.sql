ALTER TABLE "Application" ADD COLUMN "apiKeyId" TEXT;
CREATE TABLE "ProviderCall" (
  "id" TEXT PRIMARY KEY,
  "tenantId" TEXT NOT NULL,
  "clientId" TEXT NOT NULL,
  "apiKeyId" TEXT,
  "applicationId" TEXT,
  "verificationId" TEXT,
  "operationKey" TEXT NOT NULL UNIQUE,
  "provider" TEXT NOT NULL,
  "operation" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'STARTED',
  "httpStatus" INTEGER,
  "providerRequestId" TEXT,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "ProviderCall_state_check" CHECK ("state" IN ('STARTED','SUCCESS','REJECTED','UNKNOWN'))
);
CREATE INDEX "ProviderCall_tenantId_clientId_startedAt_idx" ON "ProviderCall"("tenantId", "clientId", "startedAt");
CREATE INDEX "ProviderCall_verificationId_state_idx" ON "ProviderCall"("verificationId", "state");
CREATE INDEX "ProviderCall_state_startedAt_idx" ON "ProviderCall"("state", "startedAt");
-- Billing identities must agree with ownership, even if application code regresses.
ALTER TABLE "Client" ADD CONSTRAINT "Client_id_tenantId_key" UNIQUE ("id", "tenantId");
ALTER TABLE "Application" ADD CONSTRAINT "Application_id_tenantId_clientId_key" UNIQUE ("id", "tenantId", "clientId");
ALTER TABLE "Verification" ADD CONSTRAINT "Verification_id_applicationId_key" UNIQUE ("id", "applicationId");
ALTER TABLE "VerificationCard" ADD CONSTRAINT "VerificationCard_applicationId_tenantId_clientId_key" UNIQUE ("applicationId", "tenantId", "clientId");
ALTER TABLE "FieldTask" ADD CONSTRAINT "FieldTask_verificationId_applicationId_key" UNIQUE ("verificationId", "applicationId");
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_id_clientId_key" UNIQUE ("id", "clientId");
ALTER TABLE "ProviderCall" ADD CONSTRAINT "ProviderCall_client_owner_fkey" FOREIGN KEY ("clientId", "tenantId") REFERENCES "Client"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProviderCall" ADD CONSTRAINT "ProviderCall_application_owner_fkey" FOREIGN KEY ("applicationId", "tenantId", "clientId") REFERENCES "Application"("id", "tenantId", "clientId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProviderCall" ADD CONSTRAINT "ProviderCall_verification_owner_fkey" FOREIGN KEY ("verificationId", "applicationId") REFERENCES "Verification"("id", "applicationId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Application" ADD CONSTRAINT "Application_key_owner_fkey" FOREIGN KEY ("apiKeyId", "clientId") REFERENCES "ApiKey"("id", "clientId") ON UPDATE CASCADE;
ALTER TABLE "ProviderCall" ADD CONSTRAINT "ProviderCall_key_owner_fkey" FOREIGN KEY ("apiKeyId", "clientId") REFERENCES "ApiKey"("id", "clientId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProviderCall" ADD CONSTRAINT "ProviderCall_verification_parent_check" CHECK ("verificationId" IS NULL OR "applicationId" IS NOT NULL);
ALTER TABLE "Application" DROP CONSTRAINT "Application_clientId_fkey";
ALTER TABLE "PortalUser" DROP CONSTRAINT "PortalUser_clientId_fkey";
ALTER TABLE "AadhaarOvseSession" DROP CONSTRAINT "AadhaarOvseSession_clientId_fkey";
ALTER TABLE "ApplicationDocument" DROP CONSTRAINT "ApplicationDocument_applicationId_fkey";
ALTER TABLE "VerificationCard" DROP CONSTRAINT "VerificationCard_applicationId_fkey";
ALTER TABLE "FieldTask" DROP CONSTRAINT "FieldTask_applicationId_fkey";
ALTER TABLE "FieldTask" DROP CONSTRAINT "FieldTask_verificationId_fkey";
-- Existing inconsistent rows block deployment instead of silently relabelling PII.
ALTER TABLE "Application" ADD CONSTRAINT "Application_client_owner_fkey" FOREIGN KEY ("clientId", "tenantId") REFERENCES "Client"("id", "tenantId") ON UPDATE CASCADE;
ALTER TABLE "PortalUser" ADD CONSTRAINT "PortalUser_client_owner_fkey" FOREIGN KEY ("clientId", "tenantId") REFERENCES "Client"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ApplicationDocument" ADD CONSTRAINT "ApplicationDocument_application_owner_fkey" FOREIGN KEY ("applicationId", "tenantId", "clientId") REFERENCES "Application"("id", "tenantId", "clientId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VerificationCard" ADD CONSTRAINT "VerificationCard_application_owner_fkey" FOREIGN KEY ("applicationId", "tenantId", "clientId") REFERENCES "Application"("id", "tenantId", "clientId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AadhaarOvseSession" ADD CONSTRAINT "AadhaarOvseSession_client_owner_fkey" FOREIGN KEY ("clientId", "tenantId") REFERENCES "Client"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FieldTask" ADD CONSTRAINT "FieldTask_application_owner_fkey" FOREIGN KEY ("applicationId", "tenantId", "clientId") REFERENCES "Application"("id", "tenantId", "clientId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FieldTask" ADD CONSTRAINT "FieldTask_verification_owner_fkey" FOREIGN KEY ("verificationId", "applicationId") REFERENCES "Verification"("id", "applicationId") ON DELETE CASCADE ON UPDATE CASCADE;
-- Finalized call evidence cannot be overwritten or removed by application code.
CREATE FUNCTION protect_provider_call() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'DELETE' OR OLD."state" <> 'STARTED' OR
    ROW(NEW."id", NEW."tenantId", NEW."clientId", NEW."apiKeyId", NEW."applicationId", NEW."verificationId", NEW."operationKey", NEW."provider", NEW."operation", NEW."startedAt") IS DISTINCT FROM
    ROW(OLD."id", OLD."tenantId", OLD."clientId", OLD."apiKeyId", OLD."applicationId", OLD."verificationId", OLD."operationKey", OLD."provider", OLD."operation", OLD."startedAt") THEN
   RAISE EXCEPTION 'Provider call ledger is immutable after finalization';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "ProviderCall_immutable" BEFORE UPDATE OR DELETE ON "ProviderCall" FOR EACH ROW EXECUTE FUNCTION protect_provider_call();
