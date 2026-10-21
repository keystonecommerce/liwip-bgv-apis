# Auth, roles and permissions

Every person and system that touches Liwip BGV signs in one of four ways. There are no passwords and no shared keys. Staff access comes only from roles granted to them, and the API checks every request.

## Who signs in, and how

| Who | Where | Signs in with | What they get | Lasts | Checked by |
|---|---|---|---|---|---|
| Keystone staff | BGV Control | Email code or passkey | Session cookie (httpOnly, `__Host-`), CSRF token | 12 hours (`ADMIN_SESSION_TTL_HOURS`) | `AdminAccessGuard` + role bindings |
| Partner staff: admin, operator, viewer, finance | BGV Business | Email code or passkey | Same | 12 hours | Same |
| Vendor admins and field agents | BGV Business | Email code or passkey | Same | 12 hours | Same |
| Verifiers | BGV Business | Email code or passkey | Same, plus their verifier access (level, cards, expiry) | 12 hours; access until it expires or is revoked | Same |
| People being verified | Worker app | Phone code (SMS) or passkey | Worker token (`x-worker-token`), used with the worker app's API key | 12 hours | `ApiKeyGuard` + `ScopeGuard` + `WorkerGuard` |
| Partner integrations | The partner's own systems | API key (`x-api-key`) | The key's scopes, for one program | Until revoked or its expiry | `ApiKeyGuard` + `ScopeGuard` |
| Cashfree | Payment notices | Signed webhook | Nothing beyond the notice | Per request | Signature on the raw body |
| Anyone | Public card check, invite links | Nothing | Minimal public data, rate-limited | Per request | Rate limits |
| Internal routes | Development only | `ENABLE_INTERNAL_ROUTES=true` | Internal endpoints | Off in production | `InternalRouteGuard` |

Both admin apps use the same staff sign-in. Each app has its own address, so its session cookie is its own (`liwip-bgv-admin` README, "Two apps").

## Staff sign-in

- **Email code:** a 6-digit code to the account's email, single use, 10 minutes. Codes are stored only as an HMAC. A request for an unknown address gets the same answer as a known one.
- **Passkeys:** optional. They are added from a signed-in session; one added more than 10 minutes after sign-in needs a fresh email code first.
- **Sessions:** a random token in an httpOnly cookie, with only its hash stored. Signing out ends the session. "Sign out everywhere", disabling an account, and Keystone's "revoke sessions" all bump the account's `sessionVersion`, which ends every session at once.
- **CSRF and origins:** every state-changing request must send the session's CSRF token (`X-CSRF-Token`) from an origin in `ADMIN_PANEL_ORIGINS`.
- **Accounts are invited, never self-created.**
  - The first Keystone admin comes from the seed (`ADMIN_BOOTSTRAP_EMAIL`) or `npm run admin:provision -- <email>`.
  - Keystone invites its own staff and each partner's and vendor's first admin.
  - Partner admins invite their team; vendor admins invite their field agents.
- **Invite emails link to the right app:** Keystone staff to Control (`ADMIN_CONTROL_URL`), everyone else to Business (`ADMIN_BUSINESS_URL`).

## Recent sign-in for powerful actions

Sessions last 12 hours and nobody is logged out early. Instead, a short list of powerful actions needs recent proof that it is really them. Reading never asks.

- **Recent means within the last hour** (`ADMIN_RECENT_SIGN_IN_MINUTES`, default 60) of their sign-in, a "confirm it's you", or their last powerful action.
- **The hour slides:** each powerful action restarts it. Someone working through refunds or setting up a partner is asked once at the start and not again while they keep going. A session left alone for an hour is asked again.

1. The action's route is marked `@RecentSignIn()`. When the last proof is older than the hour, the API answers 403 with `code: "RECENT_SIGN_IN_REQUIRED"`.
2. The app asks "Confirm it's you" with a passkey tap, or a code emailed to the person's own address:
   - `POST /v1/admin/auth/confirm/otp/send`, then `POST /v1/admin/auth/confirm/otp/verify` with `{ code }`;
   - or `POST /v1/admin/auth/confirm/passkey/options`, then `POST /v1/admin/auth/confirm/passkey/verify`.
3. The confirmation must come back as the same account. The app then retries the action. `GET /v1/admin/auth/session` returns `recentSignInUntil`.

**Marked routes:**
- **People and access:** inviting Keystone staff, granting or removing their roles, disabling or enabling them, revoking their sessions; inviting, re-roling or removing partner team members and vendor agents; granting, changing or revoking verifier access.
- **Partners and vendors:** disabling or enabling a partner, program or vendor; adding a partner's or vendor's admin.
- **Money and prices:** publishing or retiring a package; any check price, bulk discount or partner price change; refunds; seat adjustments; marking a usage statement paid.
- **API keys:** creating, rotating or revoking one.
- **Support tools:** reopening checks, resetting a person, purging test data.

## Roles and permissions

- **Access comes only from role bindings.** A binding is one role, granted at one scope: GLOBAL (Keystone), one partner, or one vendor.
- **Each permission has a scope.**
  - A GLOBAL permission applies only through a GLOBAL binding.
  - A partner or vendor permission applies to one partner or vendor through a binding there, or to every one through a Keystone (GLOBAL) role.
- **Keystone staff work across every partner,** or pick one with `x-partner-id` (in Control, "view as partner"). Vendors work the same way with `x-vendor-id`.
- **No privilege escalation.** To grant or remove a role, you need the right to manage people at that scope (`staff.manage`, `users.manage`, `vendor.users.manage` or `verifiers.manage`) and every permission the role carries.

The tables below are generated from `apps/verification-api/src/modules/admin-access/admin-permissions.ts`. Change the code, then run `npm run docs:roles`; the unit tests fail if this section is stale.

<!-- roles:start (generated by npm run docs:roles; do not edit by hand) -->

### Roles

| Role | Key | Granted at | For |
|---|---|---|---|
| Keystone platform admin | `KEYSTONE_PLATFORM_ADMIN` | GLOBAL | Full access to every partner, vendor, staff account and verifier. |
| Keystone ops reviewer | `KEYSTONE_OPS_REVIEWER` | GLOBAL | Reviews cases for every partner and decides checks in review. |
| Keystone finance | `KEYSTONE_FINANCE` | GLOBAL | Views revenue and partners' activity, refunds orders and issues usage statements. |
| Keystone read-only | `KEYSTONE_READ_ONLY` | GLOBAL | Views everything without changing anything. No documents. |
| Partner admin | `PARTNER_ADMIN` | PARTNER | Manages the partner's team, billing and API keys, and sees every case. |
| Partner operator | `PARTNER_OPERATOR` | PARTNER | Works the partner's cases day to day. |
| Partner viewer | `PARTNER_VIEWER` | PARTNER | Views case status without documents. |
| Partner finance | `PARTNER_FINANCE` | PARTNER | Buys seats and sees orders, statements and invoices. No verification details. |
| Vendor admin | `VENDOR_ADMIN` | VENDOR | Assigns field tasks, can perform them, and manages the vendor's agents. |
| Field agent | `FIELD_AGENT` | VENDOR | Performs ground address and police checks. |
| Verifier | `VERIFIER` | GLOBAL | Looks up cards by QR or card number only, within the access Keystone granted. |

### Keystone platform permissions

| Permission | What it allows | Keystone platform admin | Keystone ops reviewer | Keystone finance | Keystone read-only | Verifier |
|---|---|:-:|:-:|:-:|:-:|:-:|
| `partners.read` | View every partner, its company profile and programs. | ✓ | ✓ | ✓ | ✓ |  |
| `partners.manage` | Create, edit and disable partners and programs; invite partner admins. | ✓ |  |  |  |  |
| `vendors.read` | View field verification vendors. | ✓ | ✓ | ✓ | ✓ |  |
| `vendors.manage` | Create and disable vendors; invite vendor admins. | ✓ |  |  |  |  |
| `staff.read` | View Keystone staff accounts and their access. | ✓ |  |  | ✓ |  |
| `staff.manage` | Invite and disable Keystone staff and change their roles. | ✓ |  |  |  |  |
| `verifiers.manage` | Create, scope and revoke verifier accounts. | ✓ |  |  |  |  |
| `cards.verify` | Look up a Liwip BGV card by QR or card number. | ✓ |  |  |  | ✓ |
| `usage.read` | View billable verification usage per partner and program. | ✓ |  | ✓ | ✓ |  |
| `packages.manage` | Create, edit, publish and retire packages and choose their add-on checks. | ✓ |  |  |  |  |
| `pricing.manage` | Set check prices, bulk discount tiers and partner prices. | ✓ |  |  |  |  |
| `revenue.read` | View package and check sales, refunds and outstanding statements. | ✓ |  | ✓ | ✓ |  |
| `statements.manage` | Issue partners' monthly API usage statements and record their payment. | ✓ |  | ✓ |  |  |
| `orders.refund` | Refund paid orders. | ✓ |  | ✓ |  |  |
| `support.manage` | Reopen a person's checks, give them a fresh start, and (test environments) purge person data. | ✓ | ✓ |  |  |  |
| `seats.adjust` | Add or remove a partner's seats by hand, with a reason. | ✓ |  |  |  |  |

### Partner permissions (one partner, or every partner for Keystone roles)

| Permission | What it allows | Keystone platform admin | Keystone ops reviewer | Keystone finance | Keystone read-only | Partner admin | Partner operator | Partner viewer | Partner finance |
|---|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `organisation.read` | View the partner's company profile and programs. | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `cases.read` | View cases, their checks, card and activity. | ✓ | ✓ |  | ✓ | ✓ | ✓ | ✓ |  |
| `cases.documents.read` | Open documents attached to cases. | ✓ | ✓ |  |  | ✓ | ✓ |  |  |
| `cases.decide` | Clear or fail checks that are in review. | ✓ | ✓ |  |  |  |  |  |  |
| `workers.offboard` | End a person's relationship with the partner; the partner keeps history only. | ✓ |  |  |  | ✓ |  |  |  |
| `cards.read` | See the full case behind a scanned card of the partner's own people. | ✓ | ✓ |  | ✓ | ✓ | ✓ | ✓ |  |
| `users.read` | View the partner's staff accounts. | ✓ |  |  | ✓ | ✓ | ✓ |  |  |
| `users.manage` | Invite and remove the partner's staff. | ✓ |  |  |  | ✓ |  |  |  |
| `audit.read` | View the partner's audit trail. | ✓ | ✓ | ✓ | ✓ | ✓ |  |  |  |
| `billing.buy` | See prices, get quotes and pay for verification seats. | ✓ |  |  |  | ✓ |  |  | ✓ |
| `orders.read` | View orders, payments and invoices. | ✓ |  | ✓ | ✓ | ✓ |  |  | ✓ |
| `people.invite` | Upload people and send verification links, using seats. | ✓ |  |  |  | ✓ | ✓ |  |  |
| `apikeys.manage` | Create, rotate and revoke API keys for the partner's programs. A new key is shown once. | ✓ |  |  |  | ✓ |  |  |  |

### Vendor permissions (one vendor, or every vendor for Keystone roles)

| Permission | What it allows | Keystone platform admin | Keystone ops reviewer | Keystone read-only | Vendor admin | Field agent |
|---|---|:-:|:-:|:-:|:-:|:-:|
| `field.tasks.read` | View field verification tasks. | ✓ | ✓ | ✓ | ✓ | ✓ |
| `field.tasks.manage` | Assign and reassign field tasks to agents. | ✓ | ✓ |  | ✓ |  |
| `field.tasks.perform` | Accept, visit and submit field tasks. | ✓ |  |  | ✓ | ✓ |
| `vendor.users.manage` | Invite and remove the vendor's agents. | ✓ |  |  | ✓ |  |

<!-- roles:end -->

## API keys

- **Each key belongs to one program** (`Client`) of one partner, and carries scopes. The full key is shown once, at creation or rotation; only its hash is stored.
- **Managed from the apps:**
  - Keystone manages any partner's keys in Control.
  - A partner admin manages their own programs' keys in Business (`apikeys.manage`).
  - The routes are `GET/POST /v1/admin/api-keys`, `GET /v1/admin/api-keys/scopes`, and `POST /v1/admin/api-keys/:keyId/rotate` and `/revoke`.
  - Every change needs a recent sign-in.
- **`worker:cases` is Keystone-only.** It is the Liwip worker app's access to people's own cases. Partners cannot grant it, and they cannot manage keys for Liwip Direct.
- **Server-side scripts** (`npm run client:provision`, `key:rotate`, `key:revoke`, `key:list`) use the same provisioning code and audit trail, for setting up environments.
- **Scopes:**
  - `packages:read`
  - `applications:read` and `applications:write`
  - `verifications:write`, `verifications:retry` and `verifications:review`
  - `digilocker:write`, `aadhaar:read` and `aadhaar:write`
  - `otp:write`
  - `documents:read` and `documents:write`
  - `usage:read` and `audit:read`
  - `worker:cases` (Keystone only)

## Field tasks

- **Field agents use the same staff sign-in** (the `FIELD_AGENT` role at their vendor).
- **Each task belongs to the vendor Keystone handed it to** (`POST /v1/admin/field-tasks/:id/vendor`, Keystone only, while no agent has accepted it). Only that vendor's agents see it.
- **Agents work from their own list** (`GET /v1/admin/field-tasks/mine`) and accept, arrive and submit (`/v1/admin/field-tasks/:id/...`).
- **Who sees which tasks:** vendor admins see their vendor's tasks (`GET /v1/admin/field-tasks`); Keystone sees every task.

## People being verified

- The worker app's server calls the API with its own API key (`worker:cases`), then the person's worker token.
- The person proves their phone number by SMS code (MSG91) or a passkey.
- The token ties them to one partner and program, and lasts 12 hours.
- Invite links (`/v/:token`) carry a single-use token that is stored hashed, and work only for the invited number. Redeeming one gives the person a worker token for the partner's program: the worker app's key (`worker:cases`) then acts for that program on their case only.

## Support tools

Keystone's ops tools are `support.manage` routes under `/v1/admin/support`, and each needs a recent sign-in:
- **Reopen checks:** `cases/:caseId/reopen`.
- **Reset a person:** `people/reset`. It archives their cases and removes their passkeys.
- **Purge test data:** `purge`. It works only when `ADMIN_PURGE_ENABLED=true`, in test environments.

Looking a person up is the Verifications search.

## Removed in October 2026

- **The shared `X-Admin-Key` and its `/admin/*` routes.** Partner provisioning, keys, usage, audit and the support tools all live under `/v1/admin/*` now.
- **The password login `/v1/portal-auth`** and the `passwordHash` and `role` columns on staff accounts. Field tasks moved to staff sessions, from `/v1/field/tasks` to `/v1/admin/field-tasks`.
- **Moving old accounts over:** a former password-only field agent signs in with an email code once a vendor admin (or Keystone) gives them the `FIELD_AGENT` role at a vendor.

## Where it lives in the code

| What | File |
|---|---|
| Permissions and roles | `apps/verification-api/src/modules/admin-access/admin-permissions.ts` |
| The staff guard: session, CSRF, scope, permission, recent sign-in | `apps/verification-api/src/modules/admin-access/admin-access.guard.ts` |
| Route markers (`@RequirePermission`, `@RecentSignIn`, `@SignedIn`) | `apps/verification-api/src/modules/admin-access/admin-context.ts` |
| Sessions | `apps/verification-api/src/modules/admin-access/staff-session.service.ts` |
| Email codes, passkeys, confirm routes | `apps/verification-api/src/modules/staff-auth/` |
| API keys from the apps | `apps/verification-api/src/modules/admin-panel/api-keys.*` |
| Partner API keys and worker tokens | `apps/verification-api/src/common/auth/` |
