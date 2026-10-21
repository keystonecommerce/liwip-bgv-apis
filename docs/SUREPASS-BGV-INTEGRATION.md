# Surepass BGV integration

This implementation prioritizes public, documented contracts for worker background verification. It adds **20 application-linked checks** and splits the existing **21 provider operations** into separate API files. No live Surepass requests were made. Credentials, product enablement and actual sandbox responses still need to be checked in the account console.

The alignment PDF distinguishes 70 PRD checks from 72 provider products. Those are different counts. [SUREPASS-COVERAGE.md](SUREPASS-COVERAGE.md) tracks all 72 products, including partial coverage and missing documentation.

## Surepass links

- Console: https://console.surepass.app/ (API catalogue, credits, sandbox/production switch)
- Sandbox docs: https://app.surepass.app/docs/kyc (login required)
- Sandbox API base URL: `https://sandbox.surepass.app`
- Status: https://status.surepass.app/

Enabled products are listed in `integrations/surepass/products.ts` by the slug their dashboard path ends in (`identity/rc-text` → `rc-text`). Override per environment with `SUREPASS_ENABLED_PRODUCTS`. A request path that maps to no enabled product is refused before it is sent.

### Production account (enabled 2026-10-15)

Production base URL `https://kyc-api.surepass.app`; docs at https://app.surepass.app/docs/kyc (login). Surepass enabled 31 products. Not enabled on production: Aadhaar OVSE, face liveness, face match, RC V2, e-Shram, telecom and the eCourt CNR/individual-details lookups. Consequences:

- Aadhaar runs through DigiLocker only (`AADHAAR` is offered when either `digilocker` or `aadhaar-ovse` is enabled).
- The vehicle check (`RC_V2`) calls RC Text (`/rc/rc-full`) when `rc-v2` is not enabled. Both return owner, insurance, PUC, fitness, permit and blacklist fields.
- The selfie check (`FACE`) is not offered.
- Credit reports (Equifax, CRIF/CIBIL/Experian PDF), GST, CIN OCR, HSN search and cheque OCR are enabled on the account but deliberately not integrated: no workforce package uses them.

## Architecture

- `integrations/verification-provider.ts` defines the provider contract and `VERIFICATION_PROVIDER` injection token. Queues, controllers and application services depend on that contract.
- `integrations/surepass/apis/` contains a file per existing operation, preserving legacy request payloads and routes.
- `integrations/surepass/checks/` contains a file per supplementary check (application-linked API), with the documented endpoint, payload mapping, source link and, where it has one, its verdict. `check-registry.ts` lists them.
- `integrations/surepass/verifiers/` contains a file per queued check (worker cases and packages): which `apis/` call or check request runs it and how its response is judged. `verifier-registry.ts` lists them; a type with no verifier is refused as unsupported.
- `integrations/surepass/verdicts.ts` holds the shared judging rules (name matching against the worker's official names, expiry dates). `surepass-response.ts` turns the Surepass envelope into a result, or into the provider errors the queue understands.
- `integrations/surepass/products.ts` maps request paths and checks to the products enabled on the account.
- `integrations/surepass/surepass.provider.ts` only looks a check up in the registries and passes the response through `surepass-response.ts`; its other methods delegate to `apis/`.
- `integrations/surepass/surepass.transport.ts` owns bearer authentication, optional customer headers, HTTPS validation, timeout, redirect handling and response decoding.

To add a queued check, add its request to `apis/` (or reuse a `checks/` request), a verifier in `verifiers/`, a line in `verifier-registry.ts` and its products in `products.ts`.
- `domain/supplementary-checks.ts` defines provider-independent operation names, required inputs, upload constraints and consent categories.
- `modules/verifications/supplementary-check.service.ts` checks application ownership and consent, validates inputs, claims an idempotent request and persists the result.

To add another provider, implement `VerificationProvider`, register it at the `VERIFICATION_PROVIDER` factory in `verification.module.ts`, and map its responses into the port's existing contracts. Screens, routes and verification storage do not need provider endpoint changes. Setting an unsupported `VERIFICATION_PROVIDER` fails at startup; changing the environment variable alone does not implement a new adapter.

## Configuration

```dotenv
VERIFICATION_PROVIDER=surepass
SUREPASS_BASE_URL=https://sandbox.surepass.app
SUREPASS_BEARER_TOKEN=<sandbox token from your console>
SUREPASS_TIMEOUT_MS=30000
SUREPASS_CUSTOMER_ID=
```

Production uses `https://kyc-api.surepass.app` and its own token. Keep the token on the backend. Timeout must be 1,000–120,000 ms. Placeholder/missing credentials produce a configuration error before an outbound call. Existing Aadhaar and DigiLocker redirect configuration continues to apply.

New API keys provisioned by `scripts/provision-client.ts` and development seed keys include `verifications:write`. Existing keys need that scope added deliberately by the operator; the implementation does not expand existing production keys.

## Application-linked API

`GET /v1/verification-checks` lists the supported operation names, required fields, file fields and consent categories. It requires `applications:read`.

`POST /v1/applications/:applicationId/checks/:type` executes a supported check for an application owned by the authenticated tenant/client. It requires `verifications:write` and an `Idempotency-Key` of 16–128 letters, digits, underscores or hyphens (a UUID is suitable).

Example name match:

```sh
curl -X POST "$BGV_API/v1/applications/$APPLICATION_ID/checks/NAME_MATCH" \
  -H "X-API-Key: $PLATFORM_API_KEY" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: 78ec13fd-9895-43d0-b6d6-fd45b07b134c' \
  --data '{"name1":"Worker Name","name2":"Worker Name"}'
```

Example OCR:

```sh
curl -X POST "$BGV_API/v1/applications/$APPLICATION_ID/checks/PAN_OCR" \
  -H "X-API-Key: $PLATFORM_API_KEY" \
  -H 'Idempotency-Key: b0cbf1c8-a9f7-42e4-b76d-9bb86196669c' \
  -F 'file=@pan-card.png'
```

The response is a persisted verification record. Retrieve all results through the existing `GET /v1/applications/:id/verifications`. Reviewer decisions use the existing `POST /v1/verifications/:id/decision` with `verifications:review`.

| Type | JSON or multipart fields | Uploads |
| --- | --- | --- |
| NAME_MATCH | name1, name2 | — |
| MOBILE_NAME | mobileNumber | — |
| EMAIL_CHECK | email | — |
| IFSC | ifsc | — |
| UPI | upiId | — |
| BANK_ACCOUNT | accountNumber, ifsc | — |
| BANK_REPORT | accountNumber, ifsc | — |
| DIGIPIN | latitude, longitude (decimal strings) | — |
| ELECTRICITY_BILL | consumerNumber, operatorCode | — |
| VEHICLE_CHALLAN | registrationNumber | — |
| PREFILL_BY_MOBILE | mobile | — |
| AADHAAR_OCR, PAN_OCR, VOTER_OCR, PASSPORT_OCR, AADHAAR_MASK | optional usePdf | file |
| AADHAAR_OCR_FULL, LICENSE_OCR | optional usePdf | front, back |
| AML, PEP | name, dob, nationality, address | — |
| DOCTOR_REGISTRATION | registrationNumber, registrationYear | — |
| ICSI | membershipNumber | — |
| EXPERIAN_REPORT | name, mobile, pan | — |
| CRIF_REPORT | firstName, lastName, mobile, pan | — |

VEHICLE_CHALLAN uses RC Challan Advanced (`/rc/rc-related/challan-advanced`) and passes when no challan is open; open challans go to review. BANK_ACCOUNT (penny drop) and UPI fail when the account does not exist and otherwise go to review for the holder name. ELECTRICITY_BILL needs the board's `operatorCode` (`GET /v1/worker/case/electricity-operators` lists them). PASSPORT_OCR reads the Indian passport (`/ocr/passport`). PREFILL_BY_MOBILE returns a credit-bureau profile (name, date of birth, addresses, ID numbers) linked to the number: evidence only, never shown to the worker.

Upload requests accept JPEG, PNG or PDF, up to 5 MiB per file. Multipart boundaries are generated automatically. PDF uploads set `use_pdf=true` unless supplied explicitly. Unexpected fields and missing required fields are rejected before billing. The license and Aadhaar Full OCR endpoints use **front/back**, unlike the other OCR endpoints' **file** field.

BANK_REPORT is a documented account/IFSC verification report operation. It is **not labeled as penny drop or pennyless** because those product contracts were not publicly available. NAME_MATCH can compare the name returned by bank/UPI checks against the worker's ID name. Fetching a name from a phone number does not prove phone possession; the existing MSG91 OTP flow remains responsible for that.

## Consent, outcomes and retries

Every supplementary check requires recorded worker consent. DIGIPIN additionally requires `application.data.addressConsent=true`; credit reports require `application.data.creditConsent.granted=true`. Worker multipart submission now records address and biometric consent, and package-based face checks require the latter. Direct JSON applications must also include these consent flags when needed.

NAME_MATCH (`match_status`), IFSC (`exists`) and VEHICLE_CHALLAN (no open challans) can verify on their own; BANK_ACCOUNT and UPI can fail (`account_exists: false`). OCR, mobile/email lookup, prefill, address encoding, electricity bills, professional registration, watchlists and credit reports return `MANUAL_REVIEW`. API success means data retrieval succeeded, not that the worker passed BGV. CIBIL results also require review. Court search results require review when matches are returned or the expected results array is absent. These court operations do not provide police verification.

The idempotency claim is a database verification row keyed by application and caller request key. Repeating the same key and inputs returns the same record without making another provider call. Reusing a key with different fields/file content returns 409. A new key is a new billable request. Input fingerprints are stored; raw uploaded files are not persisted by supplementary checks.

Supplementary checks execute synchronously and are never automatically retried. Network/timeouts or malformed success responses may have been processed by the provider, so they become `MANUAL_REVIEW` with `PROVIDER_OUTCOME_UNKNOWN`. Queue-based checks also stop automatic retries for these uncertain outcomes. Existing queue retries for explicit transient HTTP failures remain. Supplementary checks cannot use the generic queue retry endpoint: inspect the previous outcome and submit a fresh request key when appropriate.

If the process stops between the database claim and completion, the record remains PROCESSING. Replaying its key will not charge again. Operational reconciliation is needed before resubmitting such a record. This change does not add a background recovery scheduler or a new monitoring subscription system.

## Worker case checks

The worker app (`/v1/worker/case`) offers each selectable check only when one of its products is enabled (`catalog[].available`). Two were added for production:

| Check | Consent | Input | Runs |
| --- | --- | --- | --- |
| VEHICLE_CHALLAN | vehicle (needs RC_V2) | none | Queued once the RC check finds the vehicle (verified or in review). Open challans go to review. |
| ELECTRICITY_BILL | address | `consumerNumber`, `operatorCode` via `POST checks/electricity-bill` | Verified when the name on the bill matches the worker's official name; otherwise review. |

`GET /v1/worker/case/electricity-operators` returns `{ state, operatorCode }[]` for the board picker (cached for a day; empty when the check is not offered).

## Onboarding integration and remaining work

The latest client `lib/onboarding/service.ts` still supplies `mockOnboardingService`. The backend now offers the core APIs and supplementary routes, but this change does not replace that frontend mock or implement its quick-sign-in/unlock/device behavior. Its existing worker multipart submission fields remain compatible.

Existing Aadhaar OVSE initialize/status/result flows and DigiLocker initialize remain available. DigiLocker issued-document download and additional multi-step OTP/report flows need a separate lifecycle implementation with account-specific contracts. Existing original multipart Aadhaar/selfie inputs are held in process memory by `VerificationStore`; durable queue file loading remains an existing limitation.

No database migration is needed: verification types are stored as strings, and the existing result JSON holds the request fingerprint. New checks are invoked explicitly and do not automatically expand paid packages.

Validated locally: Prisma client generation, TypeScript typecheck/build, and offline assertions for all 20 new contracts, legacy PAN/face compatibility, authentication, file-field mappings, invalid-input rejection, court outcomes, idempotency, tenant isolation, credit consent and uncertain outcomes. No paid requests, external Surepass tests or production deployment were performed.

When console documentation is available, confirm account entitlements and response schemas, then add the deferred products through the same per-operation structure. Public references are linked in each new adapter; the [Surepass documentation portal](https://e338ebdbb06e0ec4ec7d11b7a53702dc.apidog.io/) currently requires a password, so some contracts were recovered from publicly indexed API reference pages.
