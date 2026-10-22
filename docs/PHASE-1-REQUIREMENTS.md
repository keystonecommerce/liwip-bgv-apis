# Phase 1 shipping requirements — Liwip BGV

**Date:** 15 October 2026
**Source:** the 11 Phase 1 requirements from Keystone (below, R1–R11), checked against `liwip-bgv-apis` and `liwip-bgv-client` as of this date.

Phase 1 ships background verification (BGV) for two kinds of customer, corporates and individuals, over three channels: the Liwip mobile app, a browser portal and the API. Keystone runs the operations, and third-party vendors do the ground checks.

## 1. Who uses Phase 1

| Actor | What they do | Signs in with | Surface |
| --- | --- | --- | --- |
| Keystone admin / ops | Creates corporates, vendors and logins; sets packages and prices; assigns ground checks; reviews results; issues reports | Portal login, role `LIWIP_SUPPORT` | Admin console (web) |
| Corporate user (e.g. Zepto, Zomato) | Submits BGV requests for its workers or vehicles; tracks them; downloads reports | Portal login, roles `CORPORATE_ADMIN` / `CORPORATE_OPERATOR`; several users per company | Liwip app and corporate web portal |
| Individual | Requests their own BGV, alone or under a corporate code; pays if no corporate pays | Mobile OTP (and passkey) | Liwip app (BGV entry) and browser |
| Vendor / field agent | Does address and police checks on the ground; records outcome, photos and GPS | Portal login, role `FIELD_AGENT`, under a vendor organisation | Vendor portal (mobile web) |

## 2. Requirements

Status: **Built** works end to end today; **Partial** has API pieces but no UI or a gap; **Missing** is not started.

### R1. Corporate login in the Liwip app, created by Keystone

A corporate downloads the Liwip app and signs in with a login Keystone created in the admin panel. Once signed in, they can submit BGV requests.

- **Done when:**
  - Keystone creates a corporate and its first admin user from the admin console.
  - That user signs in to the app and submits a request for a worker (name, phone, module, package).
  - The worker gets a link or SMS to complete consent and documents.
- **Today (Partial):**
  - `POST /admin/partners` creates a tenant, client and API key.
  - `PortalUser` has the `CORPORATE_*` roles, and `POST /v1/portal-auth/login` issues a portal token.
  - Corporate users can only be created through seed env vars, and no corporate route accepts a portal token.
  - Corporates can submit only by API key (`POST /v1/applications`).
- **To build:**
  - Admin endpoints to create, disable and reset corporate users.
  - Portal-authenticated corporate routes: create a case, list and search cases, view a case.
  - Worker invite (SMS/link) tied to the case.
  - App screens for corporate sign-in and request submission.

### R2. Individual BGV in the app, with or without a corporate code, and direct payment

Anyone with the Liwip app taps BGV and submits a request for themselves. An individual can enter a corporate code (e.g. Zepto), which links them to that corporate and its package and payer, or go alone and pay directly.

- **Done when:**
  - An individual completes a request in the app.
  - A valid corporate code attaches the case to that corporate, which pays.
  - Without a code, the individual pays online before checks run, and gets a receipt.
- **Today (Partial):**
  - The worker flow (OTP, choosing checks, consent, DigiLocker and Aadhaar, check inputs, card) works at `/` in `liwip-bgv-client`. But every individual lands in one fixed client (`WORKER_PORTAL`).
  - The corporate code (`/api/payment-code`) only matches an env list and returns a sponsor name. It does not link the case to the corporate.
  - There is no payment gateway, order or invoice.
  - In the app, `startBgv` opens the gig-jobs flow in `keystone-mobile-app`, not this BGV flow.
- **To build:**
  - Corporate codes stored per client, so a case is created under that client and uses its package and price.
  - Payment: an order, a payment gateway with webhook verification, receipts, and refunds when no check could run.
  - Wire the app's BGV entry to this flow, either as a web view or natively (decision D1).

### R3. Browser-based login for the same concepts

Corporates and individuals can do everything in R1 and R2 from a browser.

- **Done when:** the corporate portal (R1, R5, R6) and the individual flow (R2) both work in a desktop and a mobile browser.
- **Today (Partial):** the individual flow is already a web app. `?as=organisation` shows "Organisation accounts are coming soon."
- **To build:** the corporate web portal. It shares the R1 routes, so the app and the browser use one API.

### R4. Fill in details or take pictures; we read and verify them

Users can type their details, photograph documents or upload files, and the system reads them.

- **Done when:**
  - Each document the chosen package needs can be typed, photographed or uploaded.
  - What is read from a photo or upload pre-fills the fields; the user confirms it, and then it is verified.
- **Today (Built, mostly):**
  - DigiLocker pulls Aadhaar, PAN, licence and RC as signed documents, read with PDF text and Bedrock.
  - Surepass OCR exists for Aadhaar (front, and both sides), PAN, licence and passport, plus Aadhaar masking.
  - Documents are stored in private S3 through presigned URLs, and the selfie is captured for face checks.
- **To build:**
  - Camera and upload screens in the new flow that call OCR and pre-fill the fields.
  - Aadhaar masking before any Aadhaar image is stored.
  - Move the legacy `/apply` uploads to the presigned flow.

### R5. Several browser logins per company, company profile, tracking

- **Done when:**
  - A corporate admin invites and removes their own operators.
  - The company has a profile: legal name, GSTIN, address, contacts, logo and corporate code.
  - Every case shows who created it, its status history and its checks.
  - Keystone sees all of this per company.
- **Today (Partial):**
  - `PortalUser` allows many users per client.
  - `AuditLog` records actions.
  - Case status is available by ID only.
- **To build:**
  - User invite and management routes.
  - Profile fields on the client.
  - Case list with search, filters and status counts.
  - `createdBy` on cases.
  - A per-case activity timeline from the audit log.

### R6. Keystone processes and delivers the report: Excel, API or dashboard

- **Done when:**
  - Each finished case has a final result (Pass, Fail or Review) and a report (PDF and JSON).
  - Corporates can download cases as Excel.
  - Corporates receive signed webhooks on status changes.
  - Corporates have a dashboard with counts, turnaround time and pending items.
- **Today (Missing):** per-case JSON over the API, usage counts and the worker card. There is no final result rule, report, export, webhook or dashboard.
- **To build:**
  - A final-result rule per package.
  - PDF and JSON report.
  - Excel export.
  - Webhook endpoints with signing and retries.
  - A dashboard in the corporate portal.

### R7. Keystone assigns tasks to third-party vendors or its own team

- **Done when:**
  - Ground checks (address, police) create tasks.
  - Keystone assigns or reassigns each task to a vendor or to its own team, with a due date.
  - Keystone sees open, overdue and completed tasks.
- **Today (Partial):**
  - Address checks waiting in review become `FieldTask`s, due 3 days later (`FIELD_TASK_DUE_DAYS`).
  - Vendors are organisations with their own admins and agents; Keystone's own team is one of them.
  - Keystone assigns, reassigns and cancels tasks and sets due dates; vendor admins assign their own agents (`POST /v1/admin/field-tasks/:id/assign`, `/cancel`).
  - The task list has open, overdue, completed and cancelled views with counts.
  - Address is the only task type.
- **To build:**
  - Police check as a task type (waits on D5).
  - An assignment board in the admin console.

### R8. Vendors do address and police checks manually and update them in their own login

- **Done when:** a vendor agent signs in, sees their assigned tasks, visits, records the outcome with photos, signature and GPS, and submits.
- **Today (Partial):**
  - The field-agent API exists: list tasks, accept, reject, arrive with GPS, submit with an outcome.
  - The evidence model exists, but there is no upload route.
  - There is no police-check flow and no vendor UI.
- **To build:**
  - Evidence upload.
  - Police-check outcome fields: police station, reference number, result and certificate upload.
  - A mobile-web vendor portal.

### R9. Results flow back to Keystone

- **Done when:** a vendor's submission lands on the case for Keystone review; Keystone accepts or sends it back; the case and report update.
- **Today (Partial):**
  - Submissions already write the evidence onto the check, in review with `qaRequired` set.
  - Reviewers can decide through `POST /v1/verifications/:id/decision` and the admin case routes; the case status is recalculated after each decision.
  - The review queue API (`GET /v1/admin/review-queue`) lists field results, court matches and anything else in review, oldest first.
  - Keystone sends a submitted visit back to the agent with a note (`POST /v1/admin/field-tasks/:id/send-back`); earlier attempts are kept.
- **To build:**
  - The review queue screen in the admin console.
  - The final result rule and report (R6).

### R10. People BGV and Vehicle BGV modules

Users choose a module first: **People** (identity, address, court, police, employment) or **Vehicle** (RC, insurance, PUC, fitness, permit, challans).

- **Done when:**
  - A request can be for a person, a vehicle, or both (a driver with their vehicle).
  - Each module has its own checks, packages and report section.
- **Today (Partial):** vehicle checks (RC, challans) exist only as checks on a person's case, and nothing selects a module.
- **To build:**
  - A `module` and a subject on the case (person and/or vehicle).
  - A vehicle-only case for fleet owners (decision D3).
  - Module selection in the app and portal.

### R11. Packages and add-ons with configurable prices

Inside each module: **Basic**, **Advanced** and **Full** packages, plus add-ons. The price depends on the package and add-ons chosen, and is configured in the backend.

- **Done when:**
  - Keystone creates and edits packages and add-ons per module (checks, price, validity) without a deploy.
  - It can set per-corporate prices.
  - The app and portal show the computed price before payment or submission.
  - Old cases keep the version they were sold.
- **Today (Partial):**
  - `VerificationPackage` has versions, `BASE` and `ADD_ON` kinds, a price and checks.
  - Six base packages are seeded (₹199–₹599), but they are by role (Rider, Driver and so on), not tiered.
  - There is no package admin, add-on use, per-client pricing or price display. The worker flow sells checks à la carte without prices.
- **To build:**
  - Package and add-on admin routes and screens.
  - A module and tier on each package.
  - A per-client price override.
  - A price quote route used by the app, the portal and payment.
  - Reseed as People and Vehicle × Basic, Advanced and Full (decision D4).

## 3. Proposed Phase 1 packages

To be confirmed (D4). Check names match what Surepass production supports today, and selfie match is blocked until Surepass enables face APIs.

| Module | Basic | Advanced | Full | Add-ons |
| --- | --- | --- | --- | --- |
| People | Aadhaar (DigiLocker), PAN | Basic + court records + address (electricity bill) | Advanced + physical address visit + police check + employment (UAN) | Selfie match*, driving licence, voter ID, passport, reference check |
| Vehicle | RC (owner, insurance, PUC, fitness, permit) | Basic + traffic challans | Advanced + driving licence of the driver + driver–owner relationship review | — |

\* Needs Surepass to enable face liveness and face match on production.

## 4. Shared foundations

These are needed by several requirements, so they come first:

1. **Organisations and roles:**
   - The client becomes the company, with a profile and a corporate code.
   - A vendor organisation is added.
   - Portal users belong to a company, a vendor or Keystone.
   - Every portal route is checked by role.
2. **Case model:**
   - Module, subject (person and/or vehicle), package and add-ons, payer (corporate or individual) and `createdBy`.
   - The final result.
3. **Pricing and payment:** price quote, order, gateway, receipt and refund.
4. **Notifications:** SMS to the worker for invites and missing information; email to corporates for completed reports.
5. **Admin console:** one web app for Keystone, used by R1, R5, R7, R9 and R11.

## 5. Suggested build order

| Milestone | Scope | Unblocks |
| --- | --- | --- |
| M1 Foundations | Organisations, roles, company profile, corporate code, case model with module and subject | All |
| M2 Packages and pricing | Package and add-on admin, tiers, per-client price, quote API, reseed | R10, R11 |
| M3 Corporate channel | Corporate routes, case list and search, worker invite, corporate web portal, app sign-in | R1, R3, R5 |
| M4 Individual channel | Corporate code linking, payment gateway, app BGV entry, OCR capture screens | R2, R4 |
| M5 Ground checks | Vendor organisations, assignment board, police task type, evidence upload, vendor portal, review queue | R7, R8, R9 |
| M6 Reports | Final result rules, PDF and JSON report, Excel export, webhooks, corporate dashboard | R6 |

M3 and M4 can run in parallel once M1 and M2 are in.

## 6. Decisions needed

- **D1. App integration.** Is BGV in the Liwip app a web view of `liwip-bgv-client` (fastest; one codebase for app and browser) or native screens in `keystone-mobile-app`?
- **D2. Payment gateway.** Which provider (e.g. Razorpay or Cashfree), and is GST invoicing needed in Phase 1?
- **D3. Vehicle-only cases.** Can a fleet owner verify a vehicle with no driver attached, or does every vehicle belong to a person?
- **D4. Packages and prices.** Confirm the checks in Basic, Advanced and Full per module (section 3), the prices and the add-on prices.
- **D5. Police check.** Is it done only by vendors (station visit or PCC), and what evidence counts as a pass?
- **D6. Report format.** What the corporate report must contain, and whether the Excel layout follows a corporate's own template.
- **D7. Own team versus vendors.** Is Keystone's own field team set up as one more vendor organisation (simplest), or does it need separate handling?
