# Packages, pricing and payments

**Status:** built on `feat/admin-auth-billing`, 21 October 2026, including invite redemption (§5, step 3).
**Covers:** packages and check prices configured by Keystone, bulk discounts and partner prices, quotes, Cashfree payments, GST invoices, company seats, bulk invites by WhatsApp, individuals paying for themselves, monthly API usage statements and Keystone's revenue view.

Everything here runs in `liwip-bgv-apis`. Admin routes sit under `/v1/admin/*` behind the access layer in [ADMIN-ACCESS.md](ADMIN-ACCESS.md). Money is stored as integer **paise**, never floats.

## 0. Two kinds of sale

Keystone sells two things at two different prices. Every rupee is recorded as one or the other, and the revenue view shows them side by side.

| | **Packages** | **Checks** |
|---|---|---|
| What | A role package for one person (Rider, Driver, …) | One check run (PAN, DL, RC, court record, …) |
| Price list | Package price, partner price, bulk tiers | Check price, partner price |
| Sold as | Company seats; an individual's own package | Add-on checks an individual buys with their package (paid upfront); checks a partner runs through the API (billed monthly) |
| Paid | Upfront through Cashfree | Add-ons: in the same Cashfree order. API: monthly statement, then invoice |

**Which price applies to a check**
- **Aadhaar is in every bundle**, whatever the package lists (`BUNDLED_CHECKS` in `catalog.service.ts`). It is never sold as an add-on and never billed as usage on a bundle.
- A check that is part of a case's paid package, or a paid add-on, is covered. It is never billed again.
- **Extra checks are bought before they run.** On a case under way, the person buys them (an `EXTRAS` order line on the case's own package, add-ons only, at list check prices), then adds them. A company pays only for the bundle it bought: a case on a seat is never billed as usage.
- Any other check a partner runs is billed at that partner's check price.
- Liwip Direct is never billed per check: its checks are always prepaid.

## 1. Rules

1. **The server prices everything.** Clients send package codes, add-on check types and quantities, never prices. The server returns a quote, and checkout uses that quote.
2. **Packages are versioned.** Any change to checks or price publishes a new version. Orders, seats and cases keep the version they were bought on.
3. **One payment truth.** An order is paid only when Cashfree confirms it, by a verified webhook or `GET /orders/{id}`. The browser's return is never proof.
4. **Seats are a ledger.** Every purchase, reservation, use, release or manual adjustment is an append-only row. A balance is the sum of its rows.
5. **Order IDs are 10 characters**, uppercase letters and digits without look-alikes (no `0`, `O`, `1`, `I`, `L`), e.g. `K7QM4XT9PB`.
   - The same ID is our `Order.id` and Cashfree's `order_id`.
   - It is generated with `crypto.randomInt` and kept unique by the database, with a retry on the rare clash.
   - It can't clash with the main backend's Cashfree orders (`KS-YYYYMMDD-…`, with hyphens) on the shared sandbox account.
   - Refund IDs are the order ID plus `R1`, `R2` and so on.
6. **Every change is audited** through `AuditService.record`. Price changes, discount rules, refunds and manual seat adjustments all record who did it and why.

## 2. Model

### Catalogue (configured by Keystone)

| Table | Key fields | Notes |
|---|---|---|
| `VerificationPackage` (existing, extended) | `code`, `version`, `name`, `role` (e.g. `RIDER`, `HOME_SERVICES_PRO`, `CUSTOMER_REP`), `module` (`PEOPLE` \| `VEHICLE`), `checks` JSON, `listPricePaise`, `status` (`DRAFT` \| `PUBLISHED` \| `RETIRED`), `publishedAt` | `priceInr` migrates to `listPricePaise`. Only one `PUBLISHED` version per code. Editing a published package creates a draft of the next version. |
| `PackageAddOn` | `basePackageCode`, `addOnCode` (a check type), `displayOrder` | The extra checks the Liwip app offers with a package. They are priced from `CheckRate`. |
| `CheckRate` | `tenantId` (null = list price), `checkType`, `unitPricePaise`, `validFrom`, `validTo`, `isActive` | The price of one check. A partner's row replaces the list price for that partner. Used for add-ons and API usage. |
| `DiscountRule` | `scope` (`GLOBAL` \| `PARTNER` + `tenantId`), `packageCode` (null = all), `minQty`, `maxQty` (null = no cap), `percentOffBps`, `validFrom`, `validTo`, `isActive` | Bulk tiers, e.g. 50–199 seats 5%, 200–499 10%, 500+ 15%. Quantity is counted per order line. |
| `PartnerPrice` | `tenantId`, `packageCode`, `unitPricePaise`, `validFrom`, `validTo` | A negotiated price for one partner. It replaces the list price before tiers apply. |

### Orders and payments

| Table | Key fields | Notes |
|---|---|---|
| `Quote` | `id`, `buyerType` (`PARTNER` \| `INDIVIDUAL`), `tenantId`, `clientId`, `applicationId?`, `lines` JSON, `subtotalPaise`, `discountPaise`, `taxablePaise`, `cgstPaise`, `sgstPaise`, `igstPaise`, `totalPaise`, `expiresAt` (30 min) | A full price snapshot. Read-only once created. |
| `Order` | `id` (also the Cashfree `order_id`), `quoteId`, buyer fields, `status` (`PENDING_PAYMENT` \| `PAID` \| `FAILED` \| `EXPIRED` \| `REFUNDED` \| `PARTIALLY_REFUNDED`), totals copied from the quote, `cfOrderId`, `paymentSessionId`, `idempotencyKey` (unique), `paidAt` | One order per quote. |
| `OrderLine` | `orderId`, `packageId` (exact version), `quantity`, `unitListPaise`, `unitPricePaise`, `discountRuleId?`, `addOns` JSON (check type, unit price), `packagePaise`, `addOnPaise`, `lineTotalPaise` | `packagePaise` (after discount) and `addOnPaise` are the two kinds of sale. |
| `Payment` | `orderId`, `provider` (`CASHFREE`), `cfPaymentId`, `status`, `amountPaise`, `method` (`upi` \| `card` \| `netbanking`), `receivedAt` | No card numbers or UPI IDs stored beyond what Cashfree returns masked. |
| `PaymentWebhookEvent` | `provider`, `idempotencyKey` (unique), `type`, `signatureValid`, `receivedAt`, `processedAt` | Duplicates are dropped by the unique key. |
| `Refund` | `orderId`, `refundId`, `amountPaise`, `status`, `reason`, `createdById` | |
| `Invoice` | `number` (one series per financial year), `orderId` or `statementId`, buyer GSTIN and state, SAC, tax split, `storageKey` (PDF in S3) | Issued when an order is paid, or when a usage statement is issued. |
| `PrepaidCase` | `applicationId` (id), `tenantId`, `source` (`ORDER` \| `SEAT`), `orderId?`, `inviteId?`, `packageCode`, `packageVersion`, `coveredChecks` JSON | The checks already paid for on a case. Written when an individual's order is paid, or when an invite's seat is used. |

### API usage (partners)

| Table | Key fields | Notes |
|---|---|---|
| `UsageCharge` | `verificationId` (unique), `tenantId`, `clientId`, `applicationId`, `checkType`, `checkRateId`, `unitPricePaise`, `occurredAt`, `statementId?` | One row per billed check. The unique key means a check is never billed twice. |
| `UsageStatement` | `id`, `tenantId`, `period` (`2026-10`), `status` (`ISSUED` \| `PAID` \| `VOID`), `lines` JSON (check type, count, unit price, amount), tax split, `totalPaise`, `issuedAt`, `dueAt`, `paidAt`, `paymentReference` | One per partner per month. Issuing it also issues the `Invoice`. |

### Seats and invites (companies)

| Table | Key fields | Notes |
|---|---|---|
| `SeatLedger` | `tenantId`, `packageCode`, `packageVersion`, `delta`, `kind` (`PURCHASE` \| `RESERVE` \| `RELEASE` \| `CONSUME` \| `ADJUST`), `orderLineId?`, `inviteId?`, `reason?`, `createdById?` | Append-only. Available = purchased − reserved − consumed + released ± adjustments. |
| `BulkUpload` | `tenantId`, `clientId`, `packageCode`, `fileName`, `rowCount`, `readyCount`, `rejectedCount`, `createdById` | The file itself is not kept, only the validated rows. |
| `Invite` | `tenantId`, `clientId`, `uploadId`, `packageCode`, `packageVersion`, `name`, `phone` (E.164), `tokenHash`, `status` (`SENT` \| `STARTED` \| `COMPLETED` \| `EXPIRED` \| `CANCELLED`), `expiresAt`, `messageId`, `deliveryStatus`, `applicationId?` | One open invite per phone per partner. |

## 3. Pricing

For each line, in this order:

1. **Unit price:** the active `PartnerPrice` for this partner and package, else the version's `listPricePaise`.
2. **Bulk discount:** the best active `DiscountRule` whose quantity range contains the line quantity. A `PARTNER` rule beats a `GLOBAL` rule for the same range. Only one rule applies per line; rules don't stack. It discounts the package part only.
3. **Add-on checks:** individuals only. Each one costs its `CheckRate`, and bulk tiers don't apply. Company seats carry no add-ons: a person on an invited case buys their own extras (§5, step 3).
4. **Line total:** `unit × quantity − discount + add-ons × quantity`, rounded to the paisa.
5. **GST:** 18% on the taxable value. CGST and SGST when the buyer's state matches Keystone's GSTIN state, IGST otherwise. Individuals without a GSTIN are taxed at Keystone's state. The SAC code and rate are to be confirmed with the CA.

A quote stores every input used (rule ids, prices, versions), so an invoice can always be explained.

## 4. Cashfree

**Config** (`.env`, never sent to the browser):

```dotenv
CASHFREE_ENV=sandbox            # sandbox | production
CASHFREE_APP_ID=
CASHFREE_SECRET_KEY=
CASHFREE_API_VERSION=2025-01-01 # pin; the spec's latest is 2026-01-01, test before moving
CASHFREE_RETURN_URL=https://admin.liwip.com/billing/orders/{order_id}
CASHFREE_NOTIFY_URL=https://api.liwip.com/v1/payments/cashfree/webhook
```

Base URL `https://sandbox.cashfree.com/pg` or `https://api.cashfree.com/pg`. Headers: `x-client-id`, `x-client-secret`, `x-api-version`, `x-idempotency-key`.

**Flow:**

1. `POST /v1/.../orders` with a `quoteId` and an `Idempotency-Key`. The server checks that the quote is unexpired and belongs to the caller, then creates the `Order`.
2. The server calls Cashfree `POST /orders` with:
   - `order_id`: our order id.
   - `order_amount`: rupees with 2 decimals.
   - `order_currency`: `INR`.
   - `customer_details`: `customer_id` (our tenant or worker id), `customer_phone`, `customer_name`, `customer_email`.
   - `order_meta`: `return_url` and `notify_url`.
   - `order_expiry_time`: 30 minutes.
3. The API returns only `payment_session_id` to the client.
4. The admin panel or Liwip app opens Cashfree checkout with the JS SDK (`https://sdk.cashfree.com/js/v3/cashfree.js`, `Cashfree({ mode }).checkout({ paymentSessionId })`). Both domains must be whitelisted with Cashfree.
5. Cashfree sends a webhook to `POST /v1/payments/cashfree/webhook`. This route is public; only the signature check guards it.
   - **Signature:** `base64(HMAC-SHA256(x-webhook-timestamp + rawBody, secretKey))` must equal `x-webhook-signature`. Use the raw body, never re-serialised JSON.
   - **Duplicates:** dropped by `x-idempotency-key`.
   - **Event types:** `PAYMENT_SUCCESS_WEBHOOK`, `PAYMENT_FAILED_WEBHOOK`, `PAYMENT_USER_DROPPED_WEBHOOK`.
6. On success the server confirms with `GET /orders/{order_id}` (`order_status = PAID`). Then, in one transaction:
   - Mark the order `PAID`.
   - Record the `Payment`.
   - Issue the `Invoice`.
   - Credit seats with `PURCHASE` rows (company), or start the case (individual).
7. On return, the client polls `GET /v1/.../orders/:id` until the status is final.
8. **Reconciliation:** a job every 10 minutes checks `PENDING_PAYMENT` orders against `GET /orders/{id}` and expires them after `order_expiry_time`.
9. **Refunds:** Keystone only, via `POST /orders/{order_id}/refunds` with `refund_id` and `refund_amount`, within 6 months. A refund of a seat order removes the unused seats first; refunding seats already used needs an explicit override.

## 5. Seats and invites

1. **Bulk upload:** a CSV or Excel file with `name` and `mobile`.
   - Rows are validated: Indian mobile, no duplicates in the file, no open invite for the same phone.
   - The response returns each row as ready, duplicate or invalid. Nothing is sent yet.
2. **Send:** for each ready row, the server reserves a seat (`RESERVE`), creates an `Invite` with a random single-use token, and sends it by WhatsApp through AiSensy (`INVITE_SENDER=aisensy`), as the main backend does. The link is `liwip.in/v/<token>`.
   - **Template** (approve in AiSensy as the `AISENSY_INVITE_CAMPAIGN_NAME` campaign): "Hi {{1}}, {{2}} has asked you to complete your background verification with Liwip. It takes about 10 minutes. This link works only for this number." It has one URL button, Start verification, pointing to `INVITE_LINK_BASE/v/{{1}}` with the token as the suffix.
   - If WhatsApp fails, it falls back to SMS.
   - Sending is refused if seats are short.
3. **Start:** the person opens the link and signs in by OTP. The OTP phone must equal the invite phone, otherwise the link doesn't open the case ("This link is for the number ending 0123").
   - The worker app previews the link (`GET /v1/worker/invites/:token`: partner, package, last four digits of the phone) and shows who asked before sign-in.
   - After the code, it redeems the link (`POST /v1/worker/invites/:token/redeem`) before it sets the session. The case is created under the partner's program with the invite's package version, or a draft the person already has there takes the package.
   - The checks are the package's, in the app's order: Aadhaar first, face checks as one selfie step. The person approves them but can't change them (`checksFixed`). They can buy extra checks later, paid by them, never by the company.
   - The seat moves from reserved to used (`CONSUME`). The `PrepaidCase` covers the bundle (the package plus Aadhaar) and both face steps the journey runs. Usage billing skips seat cases entirely.
   - The person gets a worker token for the partner's program. Redeeming again returns the same case.
   - Not built yet: a name on Aadhaar that doesn't match the uploaded name goes to review, not failure.
4. **Expiry:** invites not started in 30 days expire. Cancelling an invite releases its seat (`RELEASE`).
5. **Company code:** an individual who enters a corporate code uses a seat from that partner's balance for the matching package. If no seat is left, they're told to ask their company.

## 5a. API usage billing

1. **Billable check:** a check with a successful provider call (the same basis as the usage report), or a manual or field check that reached a result. A "no match" result is still billable. Provider errors and our own retries aren't billed.
2. **Rating:** a job runs every 15 minutes (`BILLING_JOBS=off` turns it off). For each new billable check on a partner tenant, it writes a `UsageCharge`, unless:
   - the check is covered by the case's `PrepaidCase`, or
   - the tenant is Liwip Direct.
   - The price is the partner's `CheckRate` active when the check ran, else the list rate.
   - A check with no rate isn't charged. It shows as unrated on the revenue view until Keystone sets a price, and is then charged at that price.
3. **Statement:** on the 1st of each month (or on demand from Keystone), the previous month's uncharged-to-statement rows are grouped by check type into one `UsageStatement` per partner, with GST, and an invoice from the same series. Statements are due in 15 days (`BILLING_STATEMENT_DUE_DAYS`).
4. **Payment:** finance marks a statement paid with the bank reference. A Cashfree payment link per statement is a later step.

## 5b. Revenue view (Keystone)

`GET /v1/admin/revenue?from=&to=&partnerId=` returns, for the period, amounts net of GST:

- **Packages:** paid orders' `packagePaise`, seats sold, package refunds, broken down by package and by partner.
- **Checks:**
  - add-ons: paid orders' `addOnPaise`;
  - API usage: `UsageCharge` totals, split into invoiced and not yet invoiced;
  - broken down by check type and by partner;
  - the count of unrated checks.
- **Totals:** gross sales, refunds, net sales, GST collected, and outstanding statements.
- **By month:** packages and checks per month, for the chart.

Refunds are counted against the stream of the order they come from (package first, then add-ons).

## 6. Routes

All admin routes are under `AdminAccessGuard`. State-changing calls need the CSRF token, and every call is audited.

**Keystone (GLOBAL):**

| Method | Route | Permission | Body / notes |
|---|---|---|---|
| GET | `/v1/admin/packages` | `packages.manage` | live and draft version per code, with `addOnCodes` |
| POST | `/v1/admin/packages` | `packages.manage` | `{ code, name, role?, module?, listPricePaise, checks: [{ type, mode?, execution? }], description?, displayOrder? }` → v1 DRAFT |
| PUT | `/v1/admin/packages/:code/draft` | `packages.manage` | any field above except `code`; creates the draft from the live version |
| POST | `/v1/admin/packages/:code/publish` · `/retire` | `packages.manage` | publishing retires the live version |
| PUT | `/v1/admin/packages/:code/add-ons` | `packages.manage` | `{ addOnChecks: ["ECOURTS_SEARCH", …] }`: check types not already in the package, each with a list price |
| GET, POST | `/v1/admin/check-rates` | `pricing.manage` | `?partnerId=` or `?scope=list`; `{ tenantId?, checkType, unitPricePaise, validFrom?, validTo? }` (no `tenantId` = list price) |
| PATCH | `/v1/admin/check-rates/:rateId` | `pricing.manage` | `{ unitPricePaise?, validFrom?, validTo?, isActive? }`; checks already charged keep their price |
| GET, POST | `/v1/admin/discount-rules` | `pricing.manage` | `?partnerId=`; `{ tenantId?, packageCode?, minQty, maxQty?, percentOffBps, validFrom?, validTo? }` |
| PATCH | `/v1/admin/discount-rules/:ruleId` | `pricing.manage` | same fields, plus `isActive` |
| GET, POST | `/v1/admin/partners/:partnerId/prices` | `pricing.manage` | `{ packageCode, unitPricePaise, validFrom?, validTo? }` |
| PATCH | `/v1/admin/partners/:partnerId/prices/:priceId` | `pricing.manage` | |
| POST | `/v1/admin/orders/:orderId/refunds` | `orders.refund` | `{ amountPaise, reason, seats?: { CODE: n }, allowUsedSeats? }`; a partner order needs `seats` |
| POST | `/v1/admin/partners/:partnerId/seats/adjust` | `seats.adjust` | `{ packageCode, delta, reason }`; never below zero |
| GET | `/v1/admin/revenue` | `revenue.read` | `?from=YYYY-MM-DD&to=YYYY-MM-DD&partnerId=` (India-time days, `to` inclusive; default this month). See §5b |
| POST | `/v1/admin/usage-charges/rate` | `statements.manage` | charges new billable checks now (the job does it every 15 minutes) |
| POST | `/v1/admin/statements/issue` | `statements.manage` | `{ period: "2026-10", partnerId? }`; only after the month ends; safe to repeat |
| POST | `/v1/admin/statements/:statementId/paid` | `statements.manage` | `{ reference, paidOn?: YYYY-MM-DD }` |

**Partner (PARTNER scope; Keystone acts for one partner with `x-partner-id`):**

| Method | Route | Permission | Body / notes |
|---|---|---|---|
| GET | `/v1/admin/catalog` | `billing.buy` | the partner's package prices and tiers, and `checkPrices` (what its API usage is billed at) |
| POST | `/v1/admin/quotes` | `billing.buy` | `{ lines: [{ packageCode, quantity }] }`; the server sets every price. Seats carry no add-ons |
| POST | `/v1/admin/orders` | `billing.buy` | `Idempotency-Key` header (16–128 chars), `{ quoteId }` → `{ orderId, paymentSessionId, mode, totalPaise, expiresAt }`. The company profile needs a contact mobile |
| GET | `/v1/admin/orders` · `/v1/admin/orders/:orderId` | `orders.read` (all partners allowed) | `?status=&page=&limit=`; reading a pending order confirms it with Cashfree first |
| GET | `/v1/admin/seats` | `people.invite` | per package: `available`, `purchased`, `reserved`, `used`, `versions` |
| POST | `/v1/admin/bulk-uploads` | `people.invite` | `{ programId, packageCode, fileName, csv }` or `rows: [{ name, mobile }]`; up to 5,000 rows, each READY, DUPLICATE, ALREADY_INVITED, INVALID_PHONE or INVALID_NAME |
| GET | `/v1/admin/bulk-uploads/:uploadId` | `people.invite` | |
| POST | `/v1/admin/bulk-uploads/:uploadId/send` | `people.invite` | reserves one seat per READY row (409 when short), then sends the links |
| GET | `/v1/admin/invites` | `people.invite` | `?status=&search=&uploadId=&page=&limit=` |
| POST | `/v1/admin/invites/:inviteId/cancel` · `/resend` | `people.invite` | cancel releases the seat; resend issues a new link |
| GET | `/v1/admin/statements` · `/v1/admin/statements/:statementId` | `orders.read` (all partners allowed) | `?status=ISSUED\|OVERDUE\|PAID&period=`; the monthly API usage statements |

Not built yet: invoice PDF download.

**Individual (Liwip app):** API key with `worker:cases` plus the worker token, the same protection as the case.
- `GET /v1/worker/billing/catalog`
- `POST /v1/worker/billing/quotes` with `{ packageCode, addOns?: [checkType] }`
- `POST /v1/worker/billing/orders` with the `Idempotency-Key` header and `{ quoteId }`
- `GET /v1/worker/billing/orders/:orderId`
- `GET /v1/worker/billing/extras`: checks the person can buy for their case under way, each at the sum of its list check prices, and whether it is already paid
- `POST /v1/worker/billing/extras/quotes` with `{ checks: [SelectableCheck] }`: after consent; pay it with `POST orders`, then add the checks (`POST /v1/worker/case/checks/add`, refused with 409 until paid). The case view lists `paidExtras` bought but not added yet.
- `POST /v1/worker/billing/quotes` is refused on a company's case: the bundle is already paid.

**Public:**
- `POST /v1/payments/cashfree/webhook`: checked against the raw body. Duplicates are dropped by `x-idempotency-key`, and rejected notices are kept.
- `GET /v/:token`: the invite landing. It redirects to `WORKER_APP_URL/?invite=<token>`, or to `?invite=expired` or `?invite=invalid`.

**Role mapping:**
- Keystone platform admin: all of the GLOBAL permissions above.
- Keystone finance: `orders.read`, `orders.refund`, `revenue.read` and `statements.manage`.
- Partner admin: `billing.buy`, `orders.read` and `people.invite`.
- Partner operator: `people.invite`.
- Partner viewers see no billing.

**Background jobs:**
- Pending orders are reconciled every 10 minutes.
- Invites expire hourly.
- Every 15 minutes, new checks are rated and last month's statements are issued.
- `BILLING_JOBS=off` turns all of them off (tests).
- Usage is rated only from `BILLING_USAGE_START`, so switching billing on never back-bills a partner's history.

## 7. Open decisions

**Settled:**
- Seller: Keystone Commerce Private Limited, GSTIN `29AAMCK2232K1Z9` (Karnataka). Every invoice records it.
- SAC `998521` (investigation services) at 18%, still to confirm with the CA.
- Invites go by WhatsApp through AiSensy.

**Later, decided by the user:**
- The check price list, set by hand.
- Cashfree production keys, after testing on staging.
- Refund policy, seat expiry, and postpaid billing for large companies.

**Still open:**
1. When a seat counts as used: on start (this design) or on send.
