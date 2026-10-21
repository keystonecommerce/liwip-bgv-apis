# Admin Access Layer (admin panel API)

The two Liwip BGV admin apps (`liwip-bgv-admin`: **Control** for Keystone, **Business** for
everyone else) call this API under `/v1/admin/*`. They are used by:

- **Keystone staff**: platform admins, ops reviewers, finance, read-only.
- **Partner staff**: partner admins, operators and viewers (e.g. Zomato). They only ever see their own partner.
- **Vendors and field agents**: ground address and police checks.
- **Verifiers**: anyone Keystone grants card-lookup access to.

Code: `apps/verification-api/src/modules/admin-access` (permissions, the guard, sessions),
`modules/staff-auth` (email OTP, passkeys), `modules/admin-panel` (routes), `modules/cards`
(card views, public verify). Migration: `prisma/migrations/20261021120000_admin_access_layer`.

**Start with [AUTH.md](AUTH.md):** every way in, recent sign-in for powerful actions, API keys,
and the roles and permissions tables generated from the code. This file holds the model and the
full route list.

## Model

| Concept | Table | Notes |
|---|---|---|
| Partner | `Tenant` (`kind = PARTNER`) | Company profile: `legalName`, `gstin`, `address`, `contacts`, `logoUrl`. `status` ACTIVE/DISABLED. |
| Liwip Direct | `Tenant` (`kind = DIRECT`, slug `liwip-direct`) | Individuals without a corporate code. Program `INDIVIDUAL`. Seeded; cannot be disabled. |
| Program | `Client` | e.g. *Zomato Delivery*. `corporateCode` is unique across all programs. |
| Vendor | `Vendor` | Field verification agency. |
| Staff account | `PortalUser` | Email + display name. No password. `sessionVersion` revokes all sessions. |
| Role binding | `StaffRoleBinding` | **The only source of access.** `roleKey` + scope: `GLOBAL`, `PARTNER` (`tenantId`) or `VENDOR` (`vendorId`). A DB check constraint keeps the scope columns consistent. |
| Session | `StaffSession` | Random token in a cookie, SHA-256 stored. Valid while unexpired, not revoked and `sessionVersion` matches the account. |
| Sign-in code | `StaffOtp` | HMAC of the code only. 10 min expiry, 5 attempts, newest code wins, 2 sends/min and 10/hour per address. |
| Passkey | `StaffPasskey`, `StaffAuthChallenge` | WebAuthn, single-use server-side challenges. |
| Verifier access | `VerifierAccess`, `VerifierCardGrant` | `SCOPED` or `UNIVERSAL`, optional expiry, revocable. |
| Card scan | `CardScan` | Every public scan and staff lookup: card, owner partner/program, via (PRINT/APP/NUMBER), viewer, view shown. |
| Relationship end | `Application.relationship*` | `ACTIVE` / `ENDED`, `relationshipEndedAt`, the status at the end, and a snapshot of the case. |
| Audit | `AuditLog` | One writer (`AuditService.record`). New: `actorUserId`, `metadata`, actor types `STAFF`, `VERIFIER`, `PUBLIC`. |

Child tables that were scoped only through a parent now carry `tenantId`/`clientId` with a
composite foreign key to the parent's `(id, tenantId, clientId)`: `Verification`,
`AadhaarPhoto`, `WorkerPhoto`, `CardScan`. The migration backfills them.

### Scoped Prisma client

Partner-facing code reads and writes only through `withTenantScope` (`common/database/tenant-prisma.ts`),
via `partnerDb(prisma, admin)`:

- `{ tenantId, clientId }`: one program (partner API keys, worker sessions), as before.
- `{ tenantId, allPrograms: true }`: every program of one partner (partner staff). Must be asked for explicitly.
- Global staff working across every partner get the plain client; only a GLOBAL binding reaches that mode.

Every model with `tenantId` is filtered by it; `Tenant`, `Client`, `ApiKey` and models owned
through `application` have explicit rules. Writes cannot change ownership.

## Permissions and roles

Keys look like `domain.resource.action` (two or three parts). Each has a scope:

- **GLOBAL** permissions apply only through GLOBAL bindings (platform features).
- **PARTNER** permissions apply to one partner through that partner's bindings, or to every partner through a GLOBAL binding.
- **VENDOR** permissions likewise, per vendor.

| Permission | Scope | Read-only | What it allows |
|---|---|---|---|
| `partners.read` | GLOBAL | yes | View every partner, its company profile and programs. |
| `partners.manage` | GLOBAL |  | Create, edit and disable partners and programs; invite partner admins. |
| `vendors.read` | GLOBAL | yes | View field verification vendors. |
| `vendors.manage` | GLOBAL |  | Create and disable vendors; invite vendor admins. |
| `staff.read` | GLOBAL | yes | View Keystone staff accounts and their access. |
| `staff.manage` | GLOBAL |  | Invite and disable Keystone staff and change their roles. |
| `verifiers.manage` | GLOBAL |  | Create, scope and revoke verifier accounts. |
| `cards.verify` | GLOBAL | yes | Look up a Liwip BGV card by QR or card number. |
| `usage.read` | GLOBAL | yes | View billable verification usage per partner and program. |
| `organisation.read` | PARTNER | yes | View the partner's company profile and programs. |
| `cases.read` | PARTNER | yes | View workers' cases, checks, card and activity. |
| `cases.documents.read` | PARTNER | yes | Open documents attached to cases. |
| `cases.decide` | PARTNER |  | Clear or fail checks that are in review. |
| `workers.offboard` | PARTNER |  | End a worker's relationship with the partner. |
| `cards.read` | PARTNER | yes | See the full case behind a scanned card of the partner's own worker. |
| `users.read` | PARTNER | yes | View the partner's staff accounts. |
| `users.manage` | PARTNER |  | Invite and remove the partner's staff. |
| `audit.read` | PARTNER | yes | View the partner's audit trail. |
| `field.tasks.read` | VENDOR | yes | View field verification tasks. |
| `field.tasks.manage` | VENDOR |  | Assign and reassign field tasks to agents. |
| `field.tasks.perform` | VENDOR |  | Accept, visit and submit field tasks. |
| `vendor.users.manage` | VENDOR |  | Invite and remove the vendor's agents. |

System roles (defined in code, `admin-permissions.ts`; a role can only be bound at its own scope):

| Role | Bound at | Permissions |
|---|---|---|
| `KEYSTONE_PLATFORM_ADMIN` | GLOBAL | all |
| `KEYSTONE_OPS_REVIEWER` | GLOBAL | `partners.read`, `vendors.read`, `organisation.read`, `cases.read`, `cases.documents.read`, `cases.decide`, `cards.read`, `audit.read`, `field.tasks.read`, `field.tasks.manage` |
| `KEYSTONE_FINANCE` | GLOBAL | `partners.read`, `vendors.read`, `usage.read`, `organisation.read`, `audit.read` |
| `KEYSTONE_READ_ONLY` | GLOBAL | every read-only permission except `cases.documents.read` and `cards.verify` |
| `PARTNER_ADMIN` | PARTNER | `organisation.read`, `cases.read`, `cases.documents.read`, `workers.offboard`, `cards.read`, `users.read`, `users.manage`, `audit.read` |
| `PARTNER_OPERATOR` | PARTNER | `organisation.read`, `cases.read`, `cases.documents.read`, `cards.read`, `users.read` |
| `PARTNER_VIEWER` | PARTNER | `organisation.read`, `cases.read`, `cards.read` |
| `VENDOR_ADMIN` | VENDOR | `field.tasks.read`, `field.tasks.manage`, `field.tasks.perform`, `vendor.users.manage` |
| `FIELD_AGENT` | VENDOR | `field.tasks.read`, `field.tasks.perform` |
| `VERIFIER` | GLOBAL | `cards.verify` (and only through an active `VerifierAccess`) |

### Privilege escalation

`canGrant(actor, grant)` decides every grant **and** removal (invite, role change, remove,
disable, revoke sessions). The actor must:

1. hold the management permission for that scope: `users.manage` (partner roles),
   `vendor.users.manage` (vendor roles), `staff.manage` (Keystone roles), `verifiers.manage` (verifier); and
2. hold **every permission of the role** at the target scope. A GLOBAL role's partner and
   vendor permissions must be held for every partner/vendor, i.e. through the actor's own GLOBAL bindings.

Disabling an account or revoking its sessions requires being able to grant every role it holds.
Nobody can remove or change their own roles or status.

## The one guard: `AdminAccessGuard`

Every `/v1/admin/*` route (except the sign-in routes) uses it. In order:

1. **Session**: the cookie must name a live session (401 otherwise).
2. **CSRF**: non-GET/HEAD/OPTIONS requests need `X-CSRF-Token` and, when an `Origin` header is
   present, an origin in `ADMIN_PANEL_ORIGINS` (403).
3. **Scope** from the route's permission:
   - GLOBAL permission: platform scope.
   - PARTNER permission:
     - `x-partner-id` header if sent (global staff choose a partner with it; partner staff may send their own);
     - otherwise the partner from the caller's binding when they have exactly one;
     - otherwise, for global staff on routes marked "all partners", every partner;
     - otherwise 400 `Choose a partner (x-partner-id)`.
     The permission is checked at that partner first (partner staff get 403 for any other id,
     without learning whether it exists), then the partner must **exist and be ACTIVE, for
     platform admins too** (403).
   - VENDOR permission: same with `x-vendor-id`.
4. **Permission** at that scope from role bindings only (403). Denials are audited (`admin.access.denied`).

Routes without an access rule are refused. The result is `request.admin`
(user, session, bindings, scope, permissions).

## Sessions, cookies, CSRF and CORS

- Sign-in: email OTP or passkey. No passwords. The response sets
  `__Host-liwip_admin=<token>; HttpOnly; Secure; SameSite=Lax; Path=/` (no `Domain`, so the
  cookie belongs to the API host only). `admin.liwip.com` and `api.liwip.com` are the same
  site, so the SPA's `fetch(..., { credentials: "include" })` sends it; other sites cannot.
- The sign-in response and `GET /v1/admin/auth/session` return `csrfToken` (an HMAC of the
  session id). Keep it in memory and send it as `X-CSRF-Token` on every POST/PATCH/PUT/DELETE.
  Only allowed origins can read it (CORS), and the custom header forces a preflight.
- CORS: `CORS_ORIGINS` + `ADMIN_PANEL_ORIGINS`, exact origins, `credentials: true`. Production
  with neither set allows no cross-origin calls.
- Sign-in POSTs (no session yet) check `Origin` against `ADMIN_PANEL_ORIGINS`.
- Lifetime `ADMIN_SESSION_TTL_HOURS` (default 12, 1 to 72). Sign out: this session
  (`/logout`) or everywhere (`/logout-all` bumps `sessionVersion`). Disabling an account or
  revoking a verifier whose only role it was also bumps it.
- Passkeys: the browser origin must be in `ADMIN_PANEL_ORIGINS`; the RP id is that host, or
  `ADMIN_WEBAUTHN_RP_ID` (e.g. `liwip.com`) to share passkeys across subdomains. Adding a
  passkey more than 10 minutes after sign-in needs a fresh email code (`code` in the body;
  403 with `code: "PASSKEY_STEP_UP_REQUIRED"` otherwise).

Environment (see `.env.example`):

| Variable | Purpose |
|---|---|
| `ADMIN_AUTH_SECRET` | 32+ chars. Signs CSRF tokens; hashes sign-in codes and IPs. Admin sign-in is 503 without it. |
| `ADMIN_PANEL_ORIGINS` | Exact admin panel origins (CORS, Origin checks, passkeys). |
| `ADMIN_PANEL_URL` | Link in invite emails. |
| `ADMIN_WEBAUTHN_RP_ID` | Optional parent domain for passkeys. |
| `ADMIN_COOKIE_SECURE` | Only `false` for local http outside production (cookie becomes `liwip_admin`). |
| `ADMIN_SESSION_TTL_HOURS`, `ADMIN_SESSION_COOKIE` | Optional overrides. |
| `ADMIN_BOOTSTRAP_EMAIL` | `npm run db:seed` makes this account a platform admin. In other environments: `npm run admin:provision -- email "Name"`. |
| `MSG91_EMAIL_DOMAIN`, `MSG91_EMAIL_FROM`, `MSG91_EMAIL_OTP_TEMPLATE_ID`, `MSG91_EMAIL_INVITE_TEMPLATE_ID` | Staff email via MSG91 Email (the SMS OTP provider already used here; uses `MSG91_AUTHKEY`). Unset outside production: emails, including codes, are printed to the API log. Unset in production: sign-in codes fail with 503 rather than being dropped. |
| `LIMIT_STAFF_OTP_SEND_PER_IP_HOUR`, `LIMIT_STAFF_SIGN_IN_PER_IP_15MIN`, `LIMIT_CARD_VERIFY_PER_IP_MIN`, `LIMIT_CARD_LOOKUP_PER_STAFF_HOUR` | Redis rate limits (fail closed). |

## Cards and verifiers

The Liwip BGV card belongs to the worker and stays valid when they leave a partner.

| Who looks up | How | Sees |
|---|---|---|
| Anyone | `GET /v1/public/cards/verify/:token` (printed QR/link `publicId` or the app's live token) | Public view: `photo`, `name`, `status`, `valid`, `validUntil`, `checksPassed` (categories). Never Aadhaar, PAN, address, DOB, phone, card number or provider results. |
| Partner staff with `cases.read` + `cards.read` at the card's partner | `POST /v1/admin/cards/lookup` | `{ view: "FULL", case }`, the case detail (as of the relationship end if the worker left). |
| Keystone staff with those permissions globally | same | Full live case. |
| Verifier, `SCOPED` | same | Verifier view (public + card number, issue date, each check's state and date). By QR: any card (the card is then remembered as scanned). By number: only cards Keystone granted or the verifier scanned before; otherwise 403. |
| Verifier, `UNIVERSAL` | same | Verifier view for any card, by QR or number. |
| Any other signed-in staff (e.g. another partner's staff) | same | Public view. |

Lookups are by `token` or `cardNumber` only: there is no listing or phone search for cards.
Every scan and lookup writes a `CardScan` row (viewer, view, via, IP hash) and an audit row;
refused lookups are audited too. Verifier access ends at `expiresAt` or on revoke; revoking
removes the `VERIFIER` binding and, if it was their only role, signs them out everywhere.

## Partner relationship end

`POST /v1/admin/cases/:caseId/relationship/end` (`workers.offboard`) marks the worker as having
left the partner **now**: the case's status, checks, card and summary are snapshotted, and the
partner keeps read access to that history. Partner staff then get:

- detail `view: "AS_OF_RELATIONSHIP_END"`: the snapshot's status and checks, documents and
  photos created up to the end, timeline events up to the end;
- list rows and the `state` / `checkType` filters based on the snapshot;
- document URLs only for documents created before the end.

Keystone staff always see the live case (`view: "LIVE"`). The worker's case and card carry
on (re-checks, new checks) without the partner seeing them.

## Audit

`AuditService.record` is the one writer. `AuditInterceptor` writes one row per admin request
(`actorType: STAFF`, `actorUserId`, the route's `@AuditAction` name, scope, resource, outcome,
status, duration); handlers add the partner/program/resource/metadata they acted on, so a
Keystone action on a partner's case shows in that partner's trail. The guard audits denials;
sign-in routes audit `auth.otp.send`, `auth.login.otp`, `auth.login.passkey`; the public card
check audits `cards.verify.public`. `GET /v1/admin/auth/session` is not audited (polled).

## Route list

All JSON. Lists return `{ items, meta: { total, page, limit, totalPages } }` with
`?page=1&limit=20` (limit up to 100), except where noted. "x-partner-id" means global staff
must send it; partner staff are resolved from their binding.

### Sign-in and session (`/v1/admin/auth`)

| Method | Path | Access | Body / notes |
|---|---|---|---|
| POST | `/otp/send` | public | `{ email }`. Always `{ sent, expiresInSeconds }`. |
| POST | `/otp/verify` | public | `{ email, code }` → sets cookie; `{ sessionId, csrfToken, expiresAt, user }` |
| POST | `/passkeys/login/options` | public | → `{ challengeId, options }` |
| POST | `/passkeys/login/verify` | public | `{ challengeId, response }` → as `/otp/verify` |
| GET | `/session` | signed in | `{ user, authMethod, signedInAt, csrfToken, access: { global, allPartners, allVendors, roles, partners: [{ id, slug, name, status, logoUrl, permissions }], vendors, verifier } }` |
| POST | `/logout` | signed in | ends this session |
| POST | `/logout-all` | signed in | ends every session (bumps `sessionVersion`) |
| GET | `/passkeys` | signed in | own passkeys |
| POST | `/passkeys/register/options` | signed in | `{ code? }` (email code when signed in > 10 min ago) |
| POST | `/passkeys/register/verify` | signed in | `{ challengeId, response, name? }` |
| DELETE | `/passkeys/:id` | signed in | |
| POST | `/confirm/otp/send` · `/confirm/otp/verify` | signed in | confirm it's you before a powerful action: a code to your own email, then `{ code }` → `{ confirmed, recentSignInUntil }` |
| POST | `/confirm/passkey/options` · `/confirm/passkey/verify` | signed in | the same with a passkey; it must be this account's |

Routes marked **recent sign-in** in AUTH.md answer `403 { code: "RECENT_SIGN_IN_REQUIRED" }` when
the last sign-in or confirmation is older than `ADMIN_RECENT_SIGN_IN_MINUTES` (15). `/session`
returns `recentSignInUntil`.

### Keystone: partners, programs, vendors, staff, verifiers, usage

| Method | Path | Permission | Body / notes |
|---|---|---|---|
| GET | `/v1/admin/partners` | `partners.read` | `?search=&status=&page=&limit=`; items include `programCount`, `caseCount` |
| POST | `/v1/admin/partners` | `partners.manage` | `{ slug, name, legalName?, gstin?, address?: { line1, line2?, city, state, pincode?, country? }, contacts?: [{ name, email?, phone?, role? }], logoUrl? (https) }` |
| GET | `/v1/admin/partners/:partnerId` | `partners.read` | profile + `programs` |
| PATCH | `/v1/admin/partners/:partnerId` | `partners.manage` | any profile field except `slug` |
| POST | `/v1/admin/partners/:partnerId/disable` · `/enable` | `partners.manage` | disabled partners' keys, staff and scope stop working |
| POST | `/v1/admin/partners/:partnerId/programs` | `partners.manage` | `{ code, name, corporateCode?, description? }` (409 on duplicate code/corporate code) |
| PATCH | `/v1/admin/partners/:partnerId/programs/:programId` | `partners.manage` | `{ name?, corporateCode?, description? }` |
| POST | `/v1/admin/partners/:partnerId/programs/:programId/disable` · `/enable` | `partners.manage` | |
| POST | `/v1/admin/partners/:partnerId/admins` | `partners.manage` | `{ email, displayName }` → staff account + `PARTNER_ADMIN`; invite email |
| GET | `/v1/admin/vendors` | `vendors.read` | |
| POST | `/v1/admin/vendors` | `vendors.manage` | `{ slug, name, contacts? }` |
| POST | `/v1/admin/vendors/:vendorId/disable` · `/enable` | `vendors.manage` | |
| POST | `/v1/admin/vendors/:vendorId/admins` | `vendors.manage` | `{ email, displayName }` → `VENDOR_ADMIN` |
| GET | `/v1/admin/staff/roles` | `staff.read` | `{ items: SYSTEM_ROLES }` for role pickers |
| GET | `/v1/admin/staff` | `staff.read` | `{ items: [{ id, email, displayName, status, lastLoginAt, roles }] }` (Keystone staff) |
| POST | `/v1/admin/staff` | `staff.manage` | `{ email, displayName, roleKey: KEYSTONE_* }` |
| GET | `/v1/admin/staff/:userId` | `staff.read` | any account: roles at every scope, passkey count, verifier access |
| POST | `/v1/admin/staff/:userId/roles` | `staff.manage` | `{ roleKey, scopeType, partnerId?, vendorId? }` (escalation-checked) |
| DELETE | `/v1/admin/staff/:userId/roles/:bindingId` | `staff.manage` | |
| POST | `/v1/admin/staff/:userId/disable` · `/enable` | `staff.manage` | disable signs out everywhere |
| POST | `/v1/admin/staff/:userId/sessions/revoke` | `staff.manage` | |
| GET | `/v1/admin/verifiers` | `verifiers.manage` | items include `user`, `level`, `expiresAt`, `revokedAt`, `active`, `cardCount` |
| POST | `/v1/admin/verifiers` | `verifiers.manage` | `{ email, displayName, level: SCOPED\|UNIVERSAL, organisation?, purpose?, expiresAt?, cardNumbers? }` |
| PATCH | `/v1/admin/verifiers/:userId` | `verifiers.manage` | `{ level?, expiresAt? }` |
| POST | `/v1/admin/verifiers/:userId/cards` | `verifiers.manage` | `{ cardNumbers: [] }` grant set |
| DELETE | `/v1/admin/verifiers/:userId/cards/:cardId` | `verifiers.manage` | |
| POST | `/v1/admin/verifiers/:userId/revoke` | `verifiers.manage` | |
| GET | `/v1/admin/verifiers/:userId/lookups` | `verifiers.manage` | the verifier's lookups (card, via, view, time) |
| GET | `/v1/admin/usage` | `usage.read` | `?from=YYYY-MM-DD&to=YYYY-MM-DD&partnerId=&programId=` |
| POST | `/v1/admin/support/cases/:caseId/reopen` | `support.manage` | `{ types: [] }` (not AADHAAR); recent sign-in |
| POST | `/v1/admin/support/people/reset` | `support.manage` | `{ phone, programId? }` archives their cases, removes passkeys; recent sign-in |
| POST | `/v1/admin/support/purge` | `support.manage` | `{ confirm: "DELETE ALL WORKER DATA" }`, only with `ADMIN_PURGE_ENABLED=true`; recent sign-in |

### Partner (and Keystone with x-partner-id)

| Method | Path | Permission | Body / notes |
|---|---|---|---|
| GET | `/v1/admin/organisation` | `organisation.read` | own company profile + programs |
| GET | `/v1/admin/users` | `users.read` | `{ items: [{ id, email, displayName, status, lastLoginAt, roles }] }` |
| POST | `/v1/admin/users` | `users.manage` | `{ email, displayName, roleKey: PARTNER_ADMIN\|PARTNER_OPERATOR\|PARTNER_VIEWER }` |
| PUT | `/v1/admin/users/:userId/role` | `users.manage` | `{ roleKey }` |
| DELETE | `/v1/admin/users/:userId` | `users.manage` | removes this partner's roles only |
| GET | `/v1/admin/cases` | `cases.read` (all partners allowed) | `?search=&state=&package=&checkType=&programId=&relationship=ACTIVE\|ENDED&from=&to=&page=&limit=`. `search` matches case id, card number, a full 10-digit phone, or the worker's name (case-sensitive substring). Items: `{ id, partner, program, worker: { name, phoneLast4 }, status, package, checks: { total, clear, needsReview, discrepancy, inProgress, waiting }, card, relationship, createdAt, updatedAt }` |
| GET | `/v1/admin/cases/:caseId` | `cases.read` (all partners allowed) | `{ id, view: LIVE\|AS_OF_RELATIONSHIP_END, partner, program, status, package, worker, photo (data URL), checks: [{ id, type, category, status, state, attemptCount, failureCode, failureReason, startedAt, completedAt, updatedAt }], checkSummary, documents, card, relationship, timeline: [{ at, kind: CASE\|CHECK\|CARD\|RELATIONSHIP\|AUDIT, action, actorType, actorUserId, outcome, detail }], createdAt, updatedAt }` |
| GET | `/v1/admin/cases/:caseId/documents/:documentId/url` | `cases.documents.read` (all partners allowed) | `{ url, expires_in_seconds }` (signed S3 URL, `S3_PRESIGNED_URL_EXPIRY_SECONDS`) |
| POST | `/v1/admin/cases/:caseId/relationship/end` | `workers.offboard` (all partners allowed) | `{ reason? }` |
| POST | `/v1/admin/cases/:caseId/checks/:checkId/decision` | `cases.decide` (all partners allowed) | `{ decision: VERIFIED\|FAILED, note? }` |
| GET | `/v1/admin/audit-logs` | `audit.read` (all partners allowed) | `?action=&actorUserId=&resourceId=&outcome=&before=ISO&limit=` → `{ items, nextBefore }` (cursor) |

Check states (`state`): `WAITING` (PENDING), `IN_PROGRESS` (QUEUED/PROCESSING), `CLEAR`
(VERIFIED), `NEEDS_REVIEW` (MANUAL_REVIEW), `DISCREPANCY` (FAILED). Card `status`
(public/verifier views): `valid`, `expiring` (< 30 days), `updating` (checks running or in
review), `expired`, `suspended`. Check categories: IDENTITY, FACE, DRIVING, VEHICLE, ADDRESS,
COURT_RECORDS, EMPLOYMENT, EDUCATION, REFERENCES, SKILLS, FINANCIAL, OTHER.

### API keys (Keystone for any partner; partner admins for their own)

| Method | Path | Permission | Body / notes |
|---|---|---|---|
| GET | `/v1/admin/api-keys` | `apikeys.manage` (all partners allowed) | `?programId=`; items `{ id, name, keyPrefix, scopes, state: ACTIVE\|EXPIRED\|REVOKED, lastUsedAt, program, partner }`, never the key |
| GET | `/v1/admin/api-keys/scopes` | `apikeys.manage` | the scopes this caller may grant, with labels (`worker:cases` for Keystone only) |
| POST | `/v1/admin/api-keys` | `apikeys.manage` | `{ programId, name?, scopes: [], expiresInDays? }` → `{ apiKey, rawKey }` (shown once); recent sign-in |
| POST | `/v1/admin/api-keys/:keyId/rotate` · `/revoke` | `apikeys.manage` | rotate returns the new `rawKey` once; recent sign-in |

### Packages, pricing, orders, seats and invites

See [PRICING-AND-PAYMENTS.md §6](PRICING-AND-PAYMENTS.md#6-routes).

### Vendor (and Keystone with x-vendor-id)

| Method | Path | Permission | Body / notes |
|---|---|---|---|
| GET | `/v1/admin/vendor-users` | `vendor.users.manage` | the vendor's team |
| POST | `/v1/admin/vendor-users` | `vendor.users.manage` | `{ email, displayName, roleKey: VENDOR_ADMIN\|FIELD_AGENT }` |
| DELETE | `/v1/admin/vendor-users/:userId` | `vendor.users.manage` | |
| GET | `/v1/admin/field-tasks` | `field.tasks.read` (all vendors allowed) | `?status=&unassigned=true`; Keystone sees every task, a vendor admin their vendor's |
| POST | `/v1/admin/field-tasks/:id/vendor` | `field.tasks.manage` | Keystone only: `{ vendorId \| null }` while no agent has accepted it |
| GET | `/v1/admin/field-tasks/mine` | `field.tasks.perform` | the agent's tasks and their vendor's open pool: `{ open, available, submitted }` |
| GET | `/v1/admin/field-tasks/:id` | `field.tasks.perform` | one task the agent may see |
| POST | `/v1/admin/field-tasks/:id/accept` · `/reject` · `/arrive` · `/submit` | `field.tasks.perform` | `reject { reason }`, `arrive { latitude?, longitude? }`, `submit { outcome, notes? }` |

### Cards

| Method | Path | Access | Notes |
|---|---|---|---|
| GET | `/v1/public/cards/verify/:token` | public, 30/min per IP | public view; 404 for unknown or expired codes |
| POST | `/v1/admin/cards/lookup` | signed in | `{ token }` or `{ cardNumber }`; see *Cards and verifiers* |

### Errors

`400` bad input or `Choose a partner (x-partner-id)`; `401` no or ended session; `403` no
permission, wrong partner, inactive partner/vendor, CSRF or origin; `404` not found (also for
another partner's ids); `409` duplicates or already ended; `429` rate limits; `503` admin
sign-in or email not configured.

## Removed

The shared `X-Admin-Key` (`/admin/*`) and the `/v1/portal-auth` password login were removed in
October 2026; see AUTH.md, "Removed in October 2026". Existing portal accounts kept the role
bindings this layer's migration gave them (`CORPORATE_ADMIN` → `PARTNER_ADMIN`,
`CORPORATE_OPERATOR` → `PARTNER_OPERATOR`, `LIWIP_SUPPORT` → `KEYSTONE_READ_ONLY`). Former field
agents need a `FIELD_AGENT` role at a vendor.
