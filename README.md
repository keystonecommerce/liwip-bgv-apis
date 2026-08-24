# Gig Verification v1

Developer-ready prototype for asynchronous gig-worker and vehicle background verification.

## Implemented architecture

```text
Employer / Platform Client
        ↓
X-API-Key authentication
        ↓
Tenant + client request context
        ↓
NestJS modular monolith
  Platform API → Verification Orchestrator → Repository
        ↓
BullMQ + Redis workers
        ↓
Surepass adapter
        ↓
Surepass Sandbox / Production API
        ↓
Normalised Result
        ↓
PostgreSQL Application Store
        ↓
NestJS Status API
        ↓
External Platform / Separate Worker UI
```

The browser never receives the Surepass bearer token. Provider credentials and provider-specific payloads remain in the NestJS backend.

## Current capabilities

- Worker-verification intake and status APIs
- Multi-tenant NestJS platform endpoints with hashed client API keys
- Tenant/client ownership enforced on every application
- BullMQ background jobs backed by Redis
- PostgreSQL persistence through Prisma
- One backend-only Surepass provider adapter
- Retry and failure handling
- Live verification status endpoints
- Internal provider-test endpoints for Sandbox diagnosis

Implemented provider integrations include PAN Comprehensive, Driving Licence, Voter ID, Address Matching, RC V2, Passport Details, CIBIL Score, Face Match, Face Liveness, Employment History by UAN V2, Current Employment PAN Mobile, eCourts Search V2, CNR Search, Individual Court Details, DigiLocker Initialize, e-Aadhaar upload and GST OCR. Some are optional or standalone tests; provider scope is still required for each Surepass Sandbox product.

See [API-INVENTORY-AND-FLOW-MAPPING.md](./API-INVENTORY-AND-FLOW-MAPPING.md) for the exact endpoint, client, package and implementation-status mapping.

## Repository structure

```text
apps/
  verification-api/src/
    common/                     Database, authentication and request context
    config/                     Environment loading
    domain/                     Provider-independent domain types
    integrations/surepass/      The only provider-specific adapter
    modules/platform/           Authenticated multi-tenant public API
    modules/verifications/      Orchestration, queue, repository and internal workflow APIs
smoke-tests/                    Authentication and tenant-isolation tests
prisma/                         PostgreSQL schema and committed migrations
```

## Requirements

- Node.js 20+
- Docker Desktop, or compatible PostgreSQL and Redis instances

## Local setup

Install dependencies:

```powershell
npm.cmd install
```

Create the local environment file:

```powershell
Copy-Item .env.example .env
```

Add the Surepass Sandbox bearer token to `.env` only when testing Surepass. `.env` is ignored by Git and must never be committed.

Start PostgreSQL and Redis:

```powershell
docker compose up -d postgres redis
npm.cmd run db:generate
npm.cmd run db:deploy
```

The project uses host ports `5440` for PostgreSQL and `6380` for Redis so it does not conflict with other Keystone development containers.

Seed the development tenants, clients, hashed API keys and packages:

```powershell
npm.cmd run db:seed
```

Start the backend API:

```powershell
npm.cmd run dev:api
```

The worker frontend is intentionally maintained separately and should call the authenticated `/v1/*` platform endpoints.

Default local ports:

| Service | URL |
|---|---|
| Verification API | `http://localhost:3000` |
| PostgreSQL | `127.0.0.1:5440` |
| Redis | `127.0.0.1:6380` |

## Database commands

| Command | Purpose |
|---|---|
| `npm.cmd run db:generate` | Regenerate the Prisma client after schema changes |
| `npm.cmd run db:migrate -- --name change-name` | Create and apply a development migration |
| `npm.cmd run db:deploy` | Apply committed migrations in a review/deployment environment |
| `npm.cmd run db:studio` | Open Prisma Studio for local data inspection |

Provision a new tenant/client and generate a hashed API credential:

```powershell
npm.cmd run client:provision -- --tenant-slug acme --tenant-name "Acme Logistics" --client-code PLATFORM --client-name "Acme Platform"
```

The raw API key is displayed once. Only its SHA-256 hash and a short prefix are stored in PostgreSQL.

## Multi-tenant platform endpoints

All routes below require `X-API-Key`. The key resolves a tenant and client; application reads and writes are scoped to both identifiers.

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/v1/packages` | List active, versioned verification packages and their check rules |
| `POST` | `/v1/applications` | Create an application owned by the authenticated tenant/client |
| `GET` | `/v1/applications/:id/verifications` | Read an owned application and its checkpoints |
| `POST` | `/v1/verifications/:id/retry` | Retry an owned verification checkpoint |

`/worker-*`, unversioned routes and `/provider-tests/surepass/*` are internal development routes. They are disabled when `NODE_ENV=production` unless explicitly enabled.

Routes under `/provider-tests/surepass/*` are development/admin diagnostics. They are not the proposed public enterprise API.

## Validation

Run static checks:

```powershell
npm.cmd run typecheck
```

With PostgreSQL, Redis and the API running, execute:

```powershell
npm.cmd run smoke
```

## Current limitations

- The versioned package engine is implemented for six priced MVP packages; package administration is still pending.
- API-key authentication, scope enforcement, tenant/client isolation and CLI provisioning are implemented; key rotation/revocation APIs and rate limits are pending.
- Webhooks, final reports, insufficiency/resubmission, Gig Cards and renewals are pending.
- Uploaded identity files remain temporary in API memory until private object storage is implemented.
- This repository is a Sandbox prototype and is not production-ready.
