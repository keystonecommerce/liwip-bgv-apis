# liwip-bgv-apis

The Liwip background-verification API (NestJS, Prisma on Postgres, BullMQ on Redis). It serves the worker app (`liwip-bgv-client`), the two admin apps, Control and Business (`liwip-bgv-admin`), and partners' own systems through API keys.

## Run it

On the VM, `liwip-bgv setup` then `liwip-bgv start` runs the database, Redis, this API (port 3011) and the apps; see `~/dev/liwip-bgv/README.md`. On its own:

```bash
npm install
cp .env.example .env          # fill it in; never commit real values
npm run db:deploy && npm run db:seed
npm run dev:api               # PORT from .env
```

| Command | What it does |
|---|---|
| `npm run typecheck` | TypeScript, no output |
| `npm run test:unit` | Unit tests |
| `npm run test:e2e` | End-to-end tests against `TEST_DATABASE_URL` and `TEST_REDIS_URL` (a dedicated test database) |
| `npm run db:migrate` | New migration in development |
| `npm run docs:roles` | Regenerates the roles and permissions tables in `docs/AUTH.md` |
| `npm run client:provision`, `key:rotate`, `key:revoke`, `key:list` | Partner programs and API keys from the command line |

Production Surepass calls spend real credits: don't run live checks without asking.

## Layout

```text
apps/verification-api/src/
  common/        auth guards (API key, scopes, worker token), audit, rate limits, database
  integrations/  Surepass checks and products
  modules/
    admin-access/   staff roles, permissions, scopes, recent sign-in
    staff-auth/     staff sign-in: email code and passkeys
    admin-panel/    Control and Business routes: partners, cases, API keys, support, card lookup
    billing/        packages, prices, quotes, Cashfree orders, seats, invites, custom bundles, usage billing
    worker-auth/    the worker app's phone codes and passkeys
    worker-cases/   a person's own case: checks, consent, DigiLocker, Aadhaar, selfie
    cards/          the Liwip BGV Card and its public check
    verifications/  cases and checks for partners' systems
    aadhaar-ovse/, digilocker/, document-storage/, field-tasks/, usage/, platform/
prisma/          schema, migrations, seed
tests/           unit and e2e
docs/            design notes (below); docs/archive holds superseded plans
```

## Docs

- [AUTH.md](docs/AUTH.md): who signs in how, roles and permissions, what each scope allows.
- [PRICING-AND-PAYMENTS.md](docs/PRICING-AND-PAYMENTS.md): packages, Aadhaar in every bundle, custom bundles, quotes, Cashfree, seats and invites, paid extra checks, usage billing.
- [ADMIN-ACCESS.md](docs/ADMIN-ACCESS.md): the admin access model in depth.
- [PROVISIONING-AND-BILLING.md](docs/PROVISIONING-AND-BILLING.md): partner programs and API keys.
- [BACKEND-ARCHITECTURE.md](docs/BACKEND-ARCHITECTURE.md), [AWS-DEPLOYMENT-MVP.md](docs/AWS-DEPLOYMENT-MVP.md).
- [SUREPASS-BGV-INTEGRATION.md](docs/SUREPASS-BGV-INTEGRATION.md), [SUREPASS-COVERAGE.md](docs/SUREPASS-COVERAGE.md).

## Deploying

- `NODE_ENV=production` turns off development shortcuts (`OTP_DEV_LOG`, internal routes, `WORKER_UNPAID_CHECKS`).
- Set `TRUST_PROXY_HOPS` to the number of proxies in front of the API, or every per-IP limit shares one bucket.
- Set `TRUSTED_RELAY_IPS` to the worker app server's egress IPs, so its users are throttled one by one.
- `ADMIN_PANEL_ORIGINS` lists the two admin apps: only they get credentialed CORS.
