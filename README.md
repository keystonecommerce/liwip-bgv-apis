# Gig Verification v1

Developer-ready prototype for asynchronous gig-worker and vehicle background verification.

## Implemented architecture

```text
Worker UI / Internal Client
        ↓
NestJS Verification API
        ↓
Verification Orchestrator
        ↓
BullMQ + Redis
        ↓
Verification Worker
        ↓
Provider Adapter
        ↓
Surepass Sandbox or Mock Provider
        ↓
Normalised Result + Application Status
        ↓
NestJS Status API
        ↓
Worker UI / Internal Client
```

The browser never receives the Surepass bearer token. Provider credentials and provider-specific payloads remain in the NestJS backend.

## Current capabilities

- One worker-verification form with required and optional checks
- NestJS application and verification endpoints
- BullMQ background jobs backed by Redis
- Surepass and mock provider adapters
- Retry and failure handling
- Live verification status in the UI
- Mock success, failure, delay, pending and manual-review scenarios
- Provider-test UI for direct Sandbox diagnosis

Implemented provider integrations include PAN Comprehensive, Driving Licence, Voter ID, Address Matching, RC V2, Passport Details, CIBIL Score, Face Match, Face Liveness, Employment History by UAN V2, eCourts Search V2, CNR Search, Individual Court Details, DigiLocker Initialize, e-Aadhaar upload and GST OCR. Some are optional or standalone tests; provider scope is still required for each Surepass Sandbox product.

See [API-INVENTORY-AND-FLOW-MAPPING.md](./API-INVENTORY-AND-FLOW-MAPPING.md) for the exact endpoint, client, package and implementation-status mapping.

## Repository structure

```text
apps/
  verification-ui/             Worker form, live status and provider-test UI
  verification-api/            NestJS API, orchestration, queue, store and adapters
  mock-verification-server/    Development-only provider simulator
smoke-tests/                    End-to-end smoke-test script
```

## Requirements

- Node.js 20+
- Docker Desktop, or another Redis instance

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

Start Redis:

```powershell
docker compose up -d redis
```

If Redis is already running on port `6379`, use that instance instead of starting another container.

Start each service in a separate terminal:

```powershell
npm.cmd run dev:mock
npm.cmd run dev:api
npm.cmd run dev:ui
```

Open `http://localhost:3002`.

Default local ports:

| Service | URL |
|---|---|
| Verification API | `http://localhost:3000` |
| Verification UI | `http://localhost:3002` |
| Mock Provider | `http://localhost:4001` |
| Redis | `127.0.0.1:6379` |

## Core internal endpoints

| Method | Route | Purpose |
|---|---|---|
| `POST` | `/worker-verifications` | Submit one worker form and create verification jobs |
| `POST` | `/applications` | Create an application from the internal schema |
| `GET` | `/applications/:id/verifications` | Read the application and live checkpoint statuses |
| `POST` | `/verifications/:id/retry` | Retry a failed verification job |

Routes under `/provider-tests/surepass/*` are development/admin diagnostics. They are not the proposed public enterprise API.

## Validation

Run static checks:

```powershell
npm.cmd run typecheck
```

With Redis, the mock provider and the API running, execute:

```powershell
npm.cmd run smoke
```

## Current limitations

- Application and verification records use an in-memory store and are lost when the API restarts.
- Verification packages are documented but the dynamic package engine is not implemented.
- Public client authentication, tenant isolation, API keys and rate limits are pending.
- Webhooks, final reports, insufficiency/resubmission, Gig Cards and renewals are pending.
- The mock provider is development-only and must not be exposed as a production option.
- This repository is a Sandbox prototype and is not production-ready.
