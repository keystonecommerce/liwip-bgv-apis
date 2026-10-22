# Backend Architecture — Modular Multi-tenant Monolith

## Request flow

```text
Employer / Platform
        ↓  X-API-Key
API-key guard (hash lookup, active/expiry validation)
        ↓
Tenant/client request context
        ↓
Platform module (`/v1/*`)
        ↓
Verification service and package rules
        ↓
PostgreSQL application + checkpoints
        ↓
BullMQ / Redis
        ↓
Surepass integration adapter
        ↓
Normalised result persisted against the tenant-owned application
```

## Source structure

```text
apps/verification-api/src/
  common/
    auth/                       API keys, scopes, tenant/client context, internal-route guard
    database/                   Shared Prisma lifecycle
  config/                       Environment loading
  domain/                       Provider-independent verification types
  integrations/
    surepass/                   Surepass payload mapping and response normalisation
  modules/
    platform/                   Authenticated public multi-tenant API
    document-storage/           Tenant-aware private S3 upload/download lifecycle
    verifications/              Orchestration, repository, BullMQ worker and internal routes
  app.module.ts                 Monolith composition root
  main.ts                       HTTP bootstrap
```

## Admin panel access

Staff (Keystone, partner staff, vendors, verifiers) use the admin panel API under `/v1/admin/*`
with httpOnly cookie sessions (email OTP or passkeys), CSRF tokens and role bindings resolved
by one guard (`AdminAccessGuard`). Partner staff read through the scoped Prisma client only.
See [ADMIN-ACCESS.md](ADMIN-ACCESS.md) for the model, roles, permissions, cookie/CSRF setup
and the route list, and [AUTH.md](AUTH.md) for every way in, recent sign-in, API keys and the
generated roles and permissions tables. The old `X-Admin-Key` routes and password login are gone.

## Tenant isolation rules

- Every application has required `tenantId` and `clientId` foreign keys.
- A raw API key is never stored. The guard performs a SHA-256 lookup using `ApiKey.keyHash`.
- API keys must be active, unexpired and linked to active clients and tenants.
- Public application and verification queries include both `tenantId` and `clientId` filters.
- A cross-tenant lookup returns `404` so it does not disclose whether another tenant's ID exists.
- Route scopes include `packages:read`, `applications:write`, `applications:read`, `verifications:retry`, `documents:write` and `documents:read` plus provider-specific scopes.
- Internal worker and provider-diagnostic routes are disabled in production by default.
- `Verification`, `AadhaarPhoto`, `WorkerPhoto` and `CardScan` carry their own `tenantId`/`clientId` (composite foreign key to the parent), so `withTenantScope` filters every table directly.

## Adding a feature

1. Add provider-independent contracts to `domain/`.
2. Add business orchestration inside a feature folder under `modules/`.
3. Put external vendor payloads and response mapping only under `integrations/<provider>/`.
4. Persist business state through Prisma and always include tenant/client ownership.
5. Expose enterprise routes under `/v1` with API-key and scope guards.
6. Add a migration, tenant-isolation test and documentation update.

## Current production gaps

- Worker session/link authentication and tenant-aware document upload flow
- Worker-portal migration from the legacy multipart upload to the implemented presigned S3 document flow
- API-key rotation/revocation administration endpoints
- Rate limiting, idempotency keys and request audit events
- Webhooks/outbox, insufficiency, resubmission and manual-review operations
- Final report, Gig Card, renewal and monitoring workflows
