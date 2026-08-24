# Gig Worker Verification — API and System Mapping

**Status:** 24 August 2026
**Reference:** LIWIP BGV / Gig Card PRD and the “Gig Worker & Vehicle Background Verification — End to End Ecosystem” flow diagram.

This document only tracks APIs and workflows relevant to the Gig Worker Verification product. It does not list unrelated Surepass catalogue products.

## 1. PRD flow covered by this project

```text
Worker or client submits details
        ↓
Worker consent and required-purpose consent
        ↓
LIWIP creates an application/case
        ↓
NestJS creates child verification jobs
        ↓
BullMQ + Redis process checks asynchronously
        ↓
NestJS Provider Adapter calls Surepass
        ↓
Results are stored in PostgreSQL against each checkpoint
        ↓
UI shows Queued / Processing / Verified / Failed / Manual Review
        ↓
Final recommendation: Pass / Fail / Manual Review
        ↓
Gig Card, sharing, renewal and client notifications
```

The current repository implements the provider-test and core orchestration layers with PostgreSQL persistence. The complete production client, card, notification and renewal layers are still pending.

## 2. Systems and clients from the PRD

| System/client | Who uses it | Main purpose | API ownership |
|---|---|---|---|
| Worker App / Worker Web Portal | Worker or driver | Enter identity, employment and vehicle details; upload documents; give consent; view status | Uses LIWIP APIs; never calls Surepass directly |
| Employer / Platform System | Gig company, fleet platform or hiring platform | Start a worker check, choose a verification package, receive status and final result | Uses LIWIP application, status, webhook and report APIs |
| Partner / Sub-vendor / Fleet Owner Portal | Vendor, fleet owner or staffing partner | Bulk upload workers and vehicles, assign checks, view reports and exceptions | Uses LIWIP bulk, assignment and report APIs |
| Field Verification App | Internal or external field verifier | Physical address visit, document review, photo capture, GPS and evidence upload | Uses LIWIP field-task APIs; does not call Surepass directly |
| Admin / Operations Console | Verification operations and QA team | Review failures, insufficiency, court matches, manual checks, overrides and audit history | Uses LIWIP admin and review APIs |
| Gig Card / Share Page | Worker, employer and authorised viewer | Show verified status, QR/NFC card, selected checks, expiry and revocation | Uses LIWIP card and sharing APIs |
| Provider Integration Service | Backend only | Convert LIWIP data to Surepass payloads, call provider APIs, normalise responses and retry safely | NestJS + BullMQ + Redis |
| Customer / Enterprise API | Enterprise clients and partner platforms | API-to-API onboarding, status callbacks, reports and billing | LIWIP public API and webhook layer |

### 2.1 Verification channels from the PRD diagram

The same backend package supports these entry channels:

- App-based worker flow
- Browser/web portal flow
- API integration for employers and platforms
- Manual verification by operations
- Offline/physical verification by field teams
- Bulk/sub-vendor upload

The provider APIs remain backend-only for all channels.

## 3. Implemented Surepass APIs

Status definitions:

- **Implemented — worker:** connected to the worker form and BullMQ verification flow.
- **Implemented — standalone:** available in the UI as a direct provider test but not automatically included in every worker case.
- **Implemented — optional:** runs only when the worker supplies the input and gives the required separate consent.
- **Implemented — inactive:** adapter exists, but the provider scope or Sandbox API is not active.
- **Partially implemented:** the first API step exists, but the full PRD workflow is not complete.

| API name | Surepass endpoint | Used by system/client | Status |
|---|---|---|---|
| PAN Comprehensive | `POST /api/v1/pan/pan-comprehensive` | Worker App; Provider Integration Service | Implemented — worker |
| Driving Licence | `POST /api/v1/driving-license/driving-license` | Worker App; Provider Integration Service | Implemented — worker |
| Voter ID | `POST /api/v1/voter-id/voter-id` | Worker App when EPIC is supplied; Provider Integration Service | Implemented — optional worker |
| Address Matching | `POST /api/v1/utils/address-matching` | Worker App; Provider Integration Service after an official address is available | Implemented — worker/conditional |
| RC Full | `POST /api/v1/rc/rc-full` | Legacy compatibility/comparison only | Not selected for Worker Verification; RC V2 is the single primary RC route |
| RC V2 | `POST /api/v1/rc/rc-v2` | Worker App for vehicle-linked roles; Provider Integration Service | Implemented — worker |
| Passport Details | `POST /api/v1/passport/passport/passport-details` | Worker App when passport details are supplied | Implemented — optional worker |
| CIBIL Credit Score | `POST /api/v1/credit-report-cibil/score` | Worker App only for an approved financial package | Implemented — optional, separate consent |
| Face Match | `POST /api/v1/face/face-match` | Worker App for selfie and ID-card comparison | Implemented — optional worker |
| Face Liveness | `POST /api/v1/face/face-liveness` | Worker App for selfie liveness | Implemented — optional worker |
| Employment History by UAN V2 | `POST /api/v1/income/employment-history-uan-v2` | Worker App when UAN is supplied | Implemented — optional worker |
| Current Employment PAN Mobile | `POST /api/v1/employment/current-employment-pan-mobile` | Security and Factory/Warehouse worker packages; Provider Integration Service | Implemented — worker; Sandbox scope/test data must be enabled by Surepass |
| eCourts Search V2 | `POST /api/v1/ecourts/ecourt-search-v2` | Worker App for court screening; Admin Console for review | Implemented — worker/Manual Review |
| eCourt CNR Search Advanced | `POST /api/v1/ecourts/ecourt-cnr-search-adv` | Admin Console and standalone testing when a CNR is known | Implemented — standalone |
| eCourt Individual Court Details | `POST /api/v1/ecourts/ecourt-individual-court-details` | Admin Console and standalone report testing | Implemented — standalone; requires provider `client_id` |
| DigiLocker Initialize | `POST /api/v1/digilocker/initialize` | Worker document-collection preparation; standalone testing | Partially implemented — session start only |
| Upload e-Aadhaar | `POST /api/v1/aadhaar/upload/eaadhaar` | Worker App as optional Aadhaar PDF route | Implemented — inactive provider scope |
| GST OCR | `POST /api/v1/ocr/gst` | Vendor/business onboarding test; not normal worker BGV | Implemented — standalone |

### 3.1 RC V2 fields used by the vehicle flow

RC V2 is the primary vehicle API because one response includes:

- RC number and registration status
- Insurance company, policy number and insurance expiry
- PUC number and PUC expiry
- Fitness validity through `fit_up_to`
- Permit number, type and validity dates
- National permit information
- Vehicle owner name, father name, addresses and owner mobile number when available
- Vehicle details, including category, maker, model, fuel, colour and chassis/engine fields
- Blacklist status

The application must calculate `Valid`, `Expired`, `Not Applicable` or `Manual Review` from the returned dates. An empty permit is not automatically a failure for a private vehicle. The worker flow must make one RC V2 request and extract the vehicle, owner, owner mobile when available, insurance, PUC, fitness, permit and blacklist information from that response. No separate RC Full or RC-to-Mobile request is required for the current worker flow. RC V2 still does not replace a full insurance policy/coverage/claims verification or a vehicle photo/driver relationship check.

### 3.2 Provider APIs are called through these internal routes

| Internal route | Purpose | Client |
|---|---|---|
| `POST /worker-verifications` | Accept one worker form, store consent and create verification jobs | Worker App / Worker Web Portal |
| `GET /v1/packages` | List active package versions and required/optional checks | Worker App; Employer / Platform System |
| `GET /applications/:id/verifications` | Return live application and checkpoint status | Worker App, Employer System, Admin Console |
| `POST /verifications/:id/retry` | Retry a failed provider job | Admin Console |
| `POST /provider-tests/surepass/rc-v2` | Direct RC V2 test | Developer/Admin UI |
| `POST /provider-tests/surepass/face-match` | Direct Face Match multipart test | Developer/Admin UI |
| `POST /provider-tests/surepass/face-liveness` | Direct Face Liveness multipart test | Developer/Admin UI |
| `POST /provider-tests/surepass/employment-history` | Direct UAN employment-history test | Developer/Admin UI |
| `POST /provider-tests/surepass/current-employment` | Direct current-employment test using PAN, mobile or UAN | Developer/Admin UI |
| `POST /provider-tests/surepass/ecourts/search` | Direct eCourts Search V2 test | Developer/Admin UI |
| `POST /provider-tests/surepass/ecourts/cnr` | Direct CNR test | Developer/Admin UI |
| `POST /provider-tests/surepass/ecourts/individual-details` | Fetch a court report using provider `client_id` | Developer/Admin UI |
| `POST /provider-tests/surepass/digilocker/initialize` | Create a DigiLocker session | Developer/Admin UI |

### 3.3 Implemented persistence

- PostgreSQL is the application and verification system of record.
- Prisma provides the schema, typed client and migrations.
- Application details, checkpoint statuses, provider results, failure details, attempts and timestamps survive API restarts.
- Redis remains dedicated to BullMQ queue state and is not used as the business-data database.
- Uploaded identity files remain temporary until private S3-compatible object storage is implemented.

## 4. APIs and workflows still required by the PRD

The following items are required or recommended by the PRD but are not yet implemented in the current repository. Endpoint names are intentionally omitted until the provider contract and internal API design are confirmed.

### 4.1 Worker onboarding and consent

| Required check/workflow | PRD module | Used by | Status |
|---|---|---|---|
| Mobile OTP send and submit | Worker onboarding, authentication and consent | Worker App / Worker Web Portal | Not implemented |
| Purpose-specific consent records | eKYC, biometric, credit and employment consent | Worker App, Admin Console, Audit Service | Partially implemented; needs production audit persistence |
| Save and resume worker application | Worker onboarding | Worker App / Worker Web Portal | Not implemented |
| Worker notification status | OTP, insufficiency, completion and expiry notifications | Worker App, Employer System | Not implemented |

### 4.2 Identity and trusted documents

| Required check/workflow | PRD module | Used by | Status |
|---|---|---|---|
| Aadhaar OVSE initialize/status/result | Preferred authorised Aadhaar route | Worker App, Provider Integration Service | Not implemented |
| Full DigiLocker SDK flow | Trusted digital documents | Worker App, Provider Integration Service | Partially implemented; SDK URL, callback and document retrieval are pending |
| Document face extraction and document quality | Identity and fraud controls | Worker App, Admin Console | Not implemented |
| Document tamper and AI-image detection | Fraud/tamper controls | Provider Integration Service, Admin Console | Not implemented |

### 4.3 Vehicle and driver checks

| Required check/workflow | PRD module | Used by | Status |
|---|---|---|---|
| Full insurance policy/coverage/claims validation | Vehicle documentation | Worker App for vehicle-linked roles, Admin Console | Not implemented beyond RC V2 metadata |
| Vehicle photo and number-plate matching | Vehicle documentation | Worker App, Field Verification App | Not implemented |
| Vehicle ownership/driver relationship check | Vehicle documentation | Worker App, Admin Console | Not implemented |
| Challan and stolen-vehicle risk checks | Vehicle risk | Worker App, Admin Console | Not implemented |

### 4.4 Employment, education and references

| Required check/workflow | PRD module | Used by | Status |
|---|---|---|---|
| Current employment verification | Employment check | Worker App, Employer System | Implemented in adapter, BullMQ package flow and test UI; Sandbox scope/test data pending |
| Education degree/diploma/institute verification | Education check | Worker App, Admin Console | Not implemented; provider option still needs confirmation |
| Reference collection and reference calls | Reference check | Worker App, Employer System, Admin Console | Not implemented |
| Skill/certification verification | Skills and certification | Worker App, Admin Console | Not implemented; depends on worker role |

### 4.5 Criminal, manual and field verification

| Required check/workflow | PRD module | Used by | Status |
|---|---|---|---|
| Police verification / PCC | Criminal check | Admin Console, Field Verification App | Not implemented; no confirmed Surepass route yet |
| Court-result review and worker response | Criminal check and fair-review process | Admin Console, Employer System | Partially implemented; eCourts result is available, review case workflow is pending |
| Manual document review | Manual verification channel | Admin Console | Not implemented as a production workflow |
| Physical address verification | Offline/physical verification channel | Field Verification App | Not implemented |
| Vendor assignment, GPS, evidence and QA | Field/vendor portal | Field Verification App, Sub-vendor Portal, Admin Console | Not implemented |

### 4.6 Employer, platform and enterprise APIs

| Required check/workflow | PRD module | Used by | Status |
|---|---|---|---|
| Client creates an application/case | API integration and employer portal | Employer / Platform System | Not implemented as a production API |
| Package and dynamic-check rules | Verification package selection | Worker App, Employer System, Admin Console | Implemented for six priced MVP packages; package administration is pending |
| Live status webhook/callback | API integration and confirmation | Employer / Platform System | Not implemented |
| Insufficiency and resubmission | Results and exception handling | Worker App, Employer System, Admin Console | Not implemented |
| PDF BGV report and downloadable evidence | Results and confirmation | Employer System, Admin Console | Not implemented |
| Bulk worker/vehicle upload | Sub-vendor / fleet-owner portal | Partner Portal | Not implemented |
| Reports, exports and audit trail | Admin and client operations | Employer System, Admin Console | Not implemented |

### 4.7 Gig Card, sharing and continuous monitoring

| Required check/workflow | PRD module | Used by | Status |
|---|---|---|---|
| Final Pass / Fail / Manual Review recommendation | Results and confirmation | Admin Console, Employer System | Not implemented as a production rules engine |
| Gig Card with QR/NFC | Identity and vehicle issued | Worker App, Employer System, Public Share Page | Not implemented |
| Share grant/revoke and access log | Gig Card features | Worker App, Employer System | Not implemented |
| Expiry, renewal and re-verification reminders | Renewal and continuous monitoring | Worker App, Employer System | Not implemented |
| Change/status alerts and watchlist monitoring | Continuous monitoring | Employer System, Admin Console | Not implemented |
| Usage, balance, billing and provider reconciliation | Platform capabilities | Admin Console, Finance/Operations | Not implemented |

## 5. Verification package design

A verification package is a predefined, versioned set of checks selected by an employer or platform. The package controls which worker fields and consents are required and which BullMQ jobs are created. The package engine, prices, advertised check counts, PostgreSQL records, idempotent seed and worker-form selection are implemented. Package creation/editing by an administrator is still pending.

| Package code | Price | Advertised checks | Business coverage | Intended workforce | Status |
|---|---:|---:|---|---|---|
| `BASIC_ID` | ₹199 | 3 | Identity, face/liveness, current address | Low-risk temporary workforce | Implemented, version 1 |
| `RIDER` | ₹449 | 8 | Basic ID, driving licence, RC, insurance, PUC, court screening | Delivery and bike logistics | Implemented, version 1 |
| `DRIVER` | ₹549 | 9 | Rider checks plus reference check | Auto, taxi and cab drivers | Implemented, version 1 |
| `HOME_SERVICES` | ₹499 | 7 | Basic ID, court screening, references, skill/certification | Customer-home access | Implemented, version 1 |
| `SECURITY` | ₹599 | 8 | Basic ID, address, court screening, employment, references | PSARA-linked security staffing | Implemented, version 1 |
| `FACTORY_WAREHOUSE` | ₹399 | 6 | Basic ID, court screening and employment | Factory and warehouse workforce | Implemented, version 1 |

The advertised count is the commercial product count. It does not always equal the number of provider calls: Face Match and Face Liveness are two technical jobs grouped under face/liveness, while RC V2 is one API request that produces separate RC, insurance and PUC business checkpoints. Current-address, reference and skill/certification checks currently create `MANUAL_REVIEW` checkpoints because no confirmed automated provider contract is connected for them.

### 5.1 Package execution rules

- The employer selects a package code/version; the current internal JSON field is `packageCode` and the worker form field is `package_code`.
- The package determines required fields, optional fields, consent requirements and verification jobs.
- Optional data does not create a job unless the worker supplies it and the required consent is recorded.
- CIBIL is not included in these six workforce packages and must never run without a separately approved financial package and consent.
- Face Match and Face Liveness require explicit biometric consent.
- RC V2 runs only for a vehicle-linked role or a package that includes vehicle verification.
- A possible eCourts match must create `MANUAL_REVIEW`; it must not automatically reject the worker.
- Package definitions must be versioned so an old application can always be traced to the exact rules used when it was created.

### 5.2 Package-driven job flow

```text
Employer selects package
        ↓
LIWIP loads the package version and required checks
        ↓
Worker receives the required form and consent requests
        ↓
Worker submits details and documents
        ↓
NestJS validates package requirements
        ↓
BullMQ creates only the jobs included in that package
        ↓
Results are normalised and evaluated
        ↓
Employer receives status, webhook events and final report
```

## 6. External platform API contract (proposed)

These routes are the planned LIWIP public API for employers, fleet platforms and enterprise clients. They are **not implemented yet** and must not be presented as currently available production endpoints.

| Method and route | Purpose | Expected user | Status |
|---|---|---|---|
| `GET /v1/packages` | List active package versions and included required/optional checks | Employer / Platform System | Implemented; API-key protected |
| `POST /v1/applications` | Create a tenant/client-owned worker verification case | Employer / Platform System | Implemented; API-key protected |
| `GET /v1/applications/:id` | Return the case summary and overall status | Employer / Platform System | Proposed |
| `GET /v1/applications/:id/verifications` | Return an owned case and every checkpoint | Employer / Platform System | Implemented; tenant/client scoped |
| `POST /v1/applications/:id/resubmissions` | Submit corrected information after an insufficiency | Worker App / Employer System | Proposed |
| `POST /v1/applications/:id/cancel` | Cancel an eligible case and stop pending work | Employer / Platform System | Proposed |
| `GET /v1/applications/:id/report` | Download or retrieve the final BGV report | Employer / Platform System | Proposed |
| `POST /v1/webhook-endpoints` | Register a verified client webhook endpoint | Employer / Platform System | Proposed |
| `GET /v1/webhook-deliveries` | Review webhook delivery status and retry history | Employer / Platform System | Proposed |
| `POST /v1/bulk/applications` | Create multiple worker or vehicle cases | Partner / Sub-vendor / Fleet Owner Portal | Proposed |

### 6.1 Platform-to-worker-to-webhook flow

```text
Employer authenticates using a LIWIP API credential
        ↓
Employer reads GET /v1/packages
        ↓
Employer creates a case with POST /v1/applications
        ↓
LIWIP returns application_id and a secure worker verification link
        ↓
Worker completes OTP, form, document upload and consent
        ↓
NestJS validates the selected package
        ↓
BullMQ + Redis process provider and manual verification jobs
        ↓
LIWIP stores normalised results and recalculates case status
        ↓
Employer receives signed webhook events
        ↓
Employer reads the final status and report from the LIWIP API
```

### 6.2 Planned webhook events

| Event | Meaning | Status |
|---|---|---|
| `application.created` | The platform created a new verification case | Proposed |
| `consent.granted` | The worker completed the required consent | Proposed |
| `application.in_progress` | At least one verification job started | Proposed |
| `application.insufficiency` | More or corrected worker information is required | Proposed |
| `verification.completed` | One verification checkpoint reached a final status | Proposed |
| `application.manual_review` | The case requires authorised human review | Proposed |
| `application.completed` | All required checks and reviews are complete | Proposed |
| `application.cancelled` | The application was cancelled | Proposed |
| `report.ready` | The final report can be retrieved | Proposed |

### 6.3 Requirements before external release

- Admin APIs for tenant lifecycle, API-key rotation and revocation (tenant/client records, hashed keys and route scopes are implemented)
- API authentication, authorisation and rate limits
- Idempotency keys for application creation and retry-safe requests
- Signed webhooks, delivery retries and replay protection
- Managed production PostgreSQL, encryption, backups, retention and deletion rules
- Consent and audit evidence linked to every sensitive check
- Package administration/add-on composition and a production recommendation rules engine
- Insufficiency, resubmission, manual review and dispute workflows
- Report generation, evidence access controls, usage metering and billing

## 7. Recommended implementation order

1. Mobile OTP and production consent/audit records.
2. Aadhaar OVSE or complete DigiLocker SDK flow.
3. Activate and validate Current Employment in Sandbox; implement education and reference workflows.
4. Vehicle relationship, photo matching and full insurance coverage checks.
5. Police/PCC and manual/field verification workflows.
6. Employer/platform case APIs, webhooks, reports and insufficiency handling.
7. Final recommendation engine and Gig Card with QR/share/revoke.
8. Renewal, continuous monitoring, notifications, usage and billing.

## 8. Important implementation rules from the PRD

- The browser must never receive or store the Surepass bearer token.
- Every worker check must have a recorded purpose and consent appropriate to the data being processed.
- CIBIL requires separate explicit credit consent and must not run by default.
- Face Match and Face Liveness require separate biometric consent.
- Court results are risk signals and possible matches must go to Manual Review; they must not cause an automatic rejection by themselves.
- RC V2 date fields must be evaluated against the current date. Permit checks are conditional on the vehicle/worker role.
- Provider APIs must be called through the backend adapter layer so provider payloads can change without changing the worker UI.
- Sandbox catalogue visibility does not prove that an API is active. Confirm provider scope, approved test data, rate limits, callbacks and production access before release.
