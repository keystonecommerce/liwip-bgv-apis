# Provisioning, successful API accounting and workflow checks

## Provisioning

The admin apps (`/v1/admin/api-keys`, AUTH.md "API keys") and the CLI commands share `PartnerProvisioning`. Each issuance, rotation and revocation commits with its audit row in one PostgreSQL transaction. Keys use 32 cryptographically random bytes; only SHA-256 digests and short prefixes are stored. Raw keys are returned once. Lists never return digests or raw credentials.

Omitted scopes grant only `packages:read`. Empty, malformed and unknown scope lists fail closed. Optional expiry is an integer from 1 to 3650 days. Rotation copies the existing scopes and expiry; an atomic active/unexpired predicate ensures concurrent rotations produce one replacement. Revoked or expired keys cannot be rotated. Revocation is idempotent. Provisioning never silently reactivates an existing disabled tenant or client.

Key management needs a staff session with `apikeys.manage` and a recent sign-in. Production responses use `Cache-Control: no-store`; operator API keys are never browser configuration. Partner authentication verifies the current database state on every request, so revocations take effect without cache delay. A shared Redis quota uses authenticated `clientId` across keys and API replicas. Pre-auth throttling uses Express's trusted client IP, not a caller-supplied forwarding header or invented key.

## Accounting contract

`ProviderCall` records **actual external provider invocations**, independently from the BGV verification verdict:

| State | Meaning | Successful API count |
| --- | --- | --- |
| `STARTED` | Durable pre-dispatch intent, response not durably finalized | 0; reconciliation required |
| `SUCCESS` | HTTP 2xx with `success: true` and structured `data` | 1 |
| `REJECTED` | Explicit 4xx/provider rejection | 0 |
| `UNKNOWN` | Timeout, malformed response or server error; completed work cannot be confirmed | 0; reconciliation required |

A successful lookup with a negative match remains one successful API invocation. A manual decision or field visit is **not** another API invocation. `totalVerifiedChecks` reports currently cleared logical checkpoints completed in the period, including authorized manual decisions; it is separate from `totalSuccessfulApiCalls`. A later QA decision cannot rewrite provider evidence or increase API billing.

`totalBillable` currently equals the confirmed successful-call count. This is a **unit ledger**, not invoice amounts or evidence of the vendor's own charging policy. Prices, candidate/corporate/shared payment splits, taxes, refunds and settlement belong to the commercial layer. In particular, Surepass may charge for some negative/rejected requests; confirm those rules before invoicing partners. Legacy `UsageEvent` rows are retained for history and never mixed into the new counts or backfilled as presumed successes.

The ledger stores server-derived tenant/client/key identities, an operation identity, endpoint, request reference and timestamps. It stores no input payload, names, document numbers, buffers, response bodies or bearer tokens. PostgreSQL composite ownership foreign keys reject mismatched clients, cases, verifications and keys. Finalized rows are immutable, including their billing identities.

The `STARTED` row must commit **before** dispatch. The final state must commit before a response is returned. A crashed process or failed final write leaves visible reconciliation work. PostgreSQL uniqueness blocks duplicate dispatch for the same operation, including concurrent workers. Queue retries may retry a known rejection such as throttling; previously successful or uncertain calls cannot automatically replay. Deliberate rechecks should create new work, preserving the previous charge evidence.

No network integration can guarantee exactly-once execution across a crash after the provider accepted work but before our response was persisted without vendor-supported idempotency. This implementation blocks ambiguous replay and makes the gap visible. Reconcile `STARTED`/`UNKNOWN` references against vendor records; corrections need a separately audited adjustment, never mutation of finalized ledger history. Automated reconciliation and invoice settlement are follow-up commercial integrations.

## Reports

- `GET /v1/usage?from=2026-09-01&to=2026-10-01` requires `usage:read`. Ownership comes from the authenticated key; query/body tenant IDs cannot broaden it.
- `GET /v1/admin/usage` (staff with `usage.read`) provides the global operator report, with optional partner and program filters.
- Both return partner totals, confirmed calls by provider/endpoint/key, known rejections, reconciliation counts, and separately verified checkpoints.
- Periods are UTC, `[from, to)` with an exclusive end, and cannot exceed 366 days. Default: trailing 30 days. Malformed or reversed periods return 400.
- Reads share a repeatable-read database snapshot so aggregates cannot disagree during concurrent completions.

## PRD flow alignment

The candidate, platform, corporate and Keystone-assisted entry points must converge on a single owned Application. Partner HTTP creation and worker multipart creation use authenticated ownership and capture the initiating API key; queue processing checks that the job's application and verification belong together before any mutation or dispatch. Scope-derived Prisma queries reinforce explicit ownership filters, following Keystone Main Backend's tenant pattern.

Digital results and vendor field evidence return to that same case. Field agents can inspect scoped allocation pools or explicitly assigned tasks. Pool synchronization cannot create another partner's tasks. Acceptance is conditional on assignment and state, preventing concurrent agents from stealing work. Submitting evidence is transactional and leaves the checkpoint in `MANUAL_REVIEW` for authorized QA. It never issues a card or increases provider-call counts by itself.

Adverse findings take priority over inconclusive results. No empty, queued, processing or pending-QA case receives a new verification card. Case recalculation and card issuance are serialized in a transaction. A case that ceases to be cleared suspends its existing active card. An authorized QA decision may clear a case without creating additional provider usage.

This PR hardens existing endpoints. It does not add payment collection/splitting, corporate browser provisioning, candidate session authorization, PCC vendor integrations, notifications, scheduled expiry reminders or annual renewal orchestration. Those entry-point and commercial features from the overview must use the same ownership/case boundaries when added. Renewals require new check identities; historical usage must remain attributable to the original work.

## Deployment and tests

Run `npm ci`, `npm run db:generate`, `npm run db:deploy`, and the build. The new migration adds ownership constraints and ledger protection. Existing inconsistent rows intentionally block migration instead of silently relabelling another tenant's records; investigate them before deployment. Do not run schema-reset commands against production.

```sh
npm run test:unit
node --test tools/surepass-mock/server.test.cjs
TEST_DATABASE_URL=postgresql://.../bgv_test \
TEST_REDIS_URL=redis://127.0.0.1:6389 npm run test:e2e
```

The end-to-end suite requires dedicated PostgreSQL and Redis instances. The database name must contain `test`, migrations are applied, and fixtures use unique names. The suite never resets an existing database. Use isolated test infrastructure: queues are real BullMQ queues. Tests start their own local standalone mock and set fake provider credentials; they never contact Surepass or spend credits.

Coverage includes API auth/scopes, one-time credentials, concurrent rotation, audit rollback, revocation, ownership reads/mutations/aggregates, database ownership enforcement, duplicate dispatch, successful work, negative verdicts, rejected/ambiguous responses, retry counts, direct session calls, immutable evidence, period boundaries and vendor-to-QA-to-card behavior.
