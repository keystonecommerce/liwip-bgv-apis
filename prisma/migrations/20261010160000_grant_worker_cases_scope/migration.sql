-- Keys that already sign workers in by OTP may open those workers' own cases.
-- Without this, OTP verify issues no worker token and the worker app cannot load the case.
UPDATE "ApiKey"
SET "scopes" = "scopes" || '["worker:cases"]'::jsonb
WHERE "scopes" ? 'otp:write'
  AND NOT ("scopes" ? 'worker:cases');
