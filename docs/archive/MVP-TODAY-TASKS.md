# Gig Verification MVP — Today Plan

**Date:** 24 August 2026

## Completed today

- [x] Add PostgreSQL 16 to Docker Compose.
- [x] Add Prisma schema and initial migration.
- [x] Persist applications and verification checkpoints.
- [x] Persist provider results, failures, attempts and timestamps.
- [x] Convert the service and BullMQ worker to asynchronous database operations.
- [x] Isolate this project on PostgreSQL port `5440` and Redis port `6380`.
- [x] Verify a full synthetic application reaches `VERIFIED`.
- [x] Restart NestJS and confirm that the application remains available.
- [x] Add versioned verification-package records and seed six commercial packages with prices.
- [x] Make application creation resolve a package version and queue only its ready checks.
- [x] Expose the active package catalogue through `GET /v1/packages`.
- [x] Add package selection and package-driven required fields to the worker form.

## Remaining today — P0

- [ ] Persist consent records separately with purpose, text version, timestamp and subject.
- [x] Add versioned platform routes under `/v1` while keeping development routes isolated.
- [x] Add hashed API-key authentication and client/tenant ownership checks.
- [ ] Add API tests for application creation, package validation, status access and retry.

## Remaining today — P1 if P0 is complete

- [ ] Add webhook endpoint registration and signed delivery skeleton.
- [ ] Emit application and verification lifecycle events through an outbox table.
- [ ] Add insufficiency and corrected-data resubmission states.
- [ ] Add a basic final recommendation calculation: Pass, Fail or Manual Review.
- [ ] Add an employer-friendly application summary response.

## This week — required for a credible MVP review

- [ ] Mobile OTP send/verify and worker session flow.
- [x] Complete package-driven worker form requirements for the six seeded MVP packages.
- [ ] Complete DigiLocker/Aadhaar route available to the provider account.
- [ ] Manual-review queue for eCourts and mismatched checks.
- [ ] Final JSON/PDF report.
- [ ] Employer webhook delivery with retries and replay protection.
- [ ] Private document storage instead of process-memory file buffers.
- [ ] Gig Card/share page MVP after the final recommendation is available.
- [ ] Security review: secrets, validation, logging redaction, rate limiting and audit trail.
- [x] Add API-key and cross-tenant isolation smoke tests.
- [ ] Add selected Surepass Sandbox integration tests without a mock provider.

## MVP completion definition

The weekly MVP is reviewable when an authenticated platform can select a package, create a case, send the worker through OTP and consent, run the configured checks asynchronously, receive status updates, handle manual review or insufficiency, and retrieve a persistent final result without exposing provider credentials.
