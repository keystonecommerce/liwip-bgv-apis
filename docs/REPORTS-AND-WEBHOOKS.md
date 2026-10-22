# Final result, reports and webhooks

How a case gets its final result, what the JSON report holds, and how partners receive signed events. PDF and Excel reports wait on decision D6 ([PHASE-1-REQUIREMENTS.md](PHASE-1-REQUIREMENTS.md)).

## Final result

A case's `finalResult` is `PASS`, `FAIL` or `REVIEW`. It stays `null` while any check is waiting or running. It is worked out again on every status change (`domain/final-result.ts`) and stored with `finalResultAt`.

- **Each package check has a rule, `onFail`.** It says what that check's failure does to the case: `FAIL` the case, send it to `REVIEW`, or `IGNORE` it.
  - Required checks default to `FAIL` and optional ones to `REVIEW`.
  - Set it per check when creating or editing a package: `checks: [{ type, mode, execution, onFail }]`.
- **A check in review makes the case `REVIEW`.**
- **`FAIL` wins over `REVIEW`, and `REVIEW` over `PASS`.**
- **Checks the package does not list count as required.** These are a person's own choices and extras bought later.

The case `status` is unchanged: it still shows the worst check, so a case can be `VERIFICATION_FAILED` with a `PASS` result when the only failure was a check its package ignores.

Where it shows:
- The partner API (`finalResult` on the case).
- The admin case list and detail (`finalResult`, and `?result=PASS|FAIL|REVIEW` on the list).
- The report and the webhook events.

## JSON report

- `GET /v1/applications/:id/report` with an API key (`applications:read`), for a case that key may read.
- `GET /v1/admin/cases/:caseId/report` in the admin apps (`cases.read`). A partner sees a case whose relationship ended as it was that day, with `asOf` set.

```json
{
  "reportVersion": 1,
  "generatedAt": "2026-10-22T10:00:00.000Z",
  "asOf": null,
  "case": { "id": "app_…", "status": "VERIFIED", "partner": { "id": "…", "name": "…" }, "program": { "id": "…", "name": "…" }, "package": { "code": "RIDER", "name": "Rider", "version": 3 }, "openedAt": "…", "completedAt": "…" },
  "result": { "final": "PASS", "because": [] },
  "subject": { "person": { "name": "Asha Verma", "phoneLast4": "******4321" }, "vehicle": { "registrationNumber": "KA01AB1234" } },
  "sections": [
    { "module": "PEOPLE", "checks": [{ "id": "…", "type": "PAN", "category": "IDENTITY", "required": true, "onFail": "FAIL", "status": "VERIFIED", "state": "CLEAR", "note": null, "completedAt": "…" }] },
    { "module": "VEHICLE", "checks": [ … ] }
  ],
  "card": { "cardNumber": "…", "status": "ACTIVE", "issuedAt": "…", "validUntil": "…" }
}
```

- **`result.because`** lists the checks behind a `FAIL` or `REVIEW`.
- **`note`** is the failure reason or the reviewer's note.
- **A field-visit check** adds `fieldVisit: { outcome, submittedAt, evidenceCount }`.
- **What it leaves out:** ID numbers, documents and provider responses.
- **Versioning:** `reportVersion` changes only when a field changes meaning or goes away.

## Webhooks

Partners add endpoints in Business, and Keystone can add them for any partner in Control. Both need the permission `webhooks.manage`, which partner admins hold.

| Method | Path | Notes |
|---|---|---|
| GET | `/v1/admin/webhooks` | endpoints, with counts of deliveries `waiting` and `failed` |
| POST | `/v1/admin/webhooks` | `{ url, programId?, description? }` → `{ endpoint, secret }`. The secret is shown once. Without `programId` the endpoint gets every program's events. Keystone names the partner with `x-partner-id` or a `programId`. Recent sign-in. Up to 10 active per partner. |
| POST | `/v1/admin/webhooks/:id/rotate-secret` | `{ endpoint, secret }`, the new secret shown once. Recent sign-in. |
| POST | `/v1/admin/webhooks/:id/disable` · `/enable` | A disabled endpoint gets no new events; its waiting deliveries fail. |
| POST | `/v1/admin/webhooks/:id/test` | queues a `webhook.test` event |
| GET | `/v1/admin/webhooks/:id/deliveries` | the last 100: status, attempts, last HTTP status and error |
| POST | `/v1/admin/webhooks/deliveries/:deliveryId/retry` | sends it again now; a failed one gets a fresh set of attempts |

### Events

| Event | When |
|---|---|
| `case.status_changed` | the case status changes |
| `case.completed` | the final result is set or changes |
| `webhook.test` | sent from the test route |

```json
{ "id": "evt_…", "type": "case.completed", "createdAt": "…",
  "data": { "caseId": "app_…", "programId": "client_…", "packageCode": "RIDER", "status": "VERIFIED", "previousStatus": "MANUAL_REVIEW", "finalResult": "PASS", "report": "/v1/applications/app_…/report" } }
```

- **No personal data in events.** Read the report with the API key for the details.
- **Which cases send events:** cases in the endpoint's partner (and program, when set), only while the person's relationship with the partner is active.
- **No lost or phantom events.** Each event is written in the same transaction as the change that caused it (an outbox). It is never lost, and never sent for a change that rolled back.

### Delivery and signature

- **One POST per event**, as JSON, with these headers:
  - `Liwip-Event`: the event type.
  - `Liwip-Delivery`: the delivery id. It is stable across retries, so use it to ignore repeats.
  - `Liwip-Signature: t=<unix seconds>,v1=<hex>`.
- **Any 2xx counts as delivered.** Redirects are not followed.
- **The signature** is HMAC-SHA256 with the endpoint's secret over `<t>.<raw body>`. Compare in constant time, and reject a `t` more than five minutes old.

```js
const [t, v1] = header.split(",").map((part) => part.split("=")[1]);
const expected = crypto.createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
const ok = crypto.timingSafeEqual(Buffer.from(v1), Buffer.from(expected)) && Date.now() / 1000 - Number(t) < 300;
```

- **Retries:** after 1 min, 5 min, 15 min, 1 h, 3 h, 6 h and 12 h (8 attempts), then the delivery is `FAILED`. Each request times out after 10 seconds.
- **URLs:** endpoints must be `https` and resolve to a public address. This is checked when the endpoint is saved and again before each delivery. `WEBHOOK_INSECURE_HOSTS` exempts named hosts, for tests and local receivers.
- **Secrets at rest:** encrypted with AES-256-GCM under `WEBHOOK_SECRET_KEY` (32 bytes, base64), which production needs. Outside production a key derived from `ADMIN_AUTH_SECRET` stands in.
- **The sender** is `WebhookDispatcher`. It polls every `WEBHOOK_POLL_MS` (default 5000), and `WEBHOOK_JOBS=off` turns it off. A delivery claimed by a process that died is picked up again after two minutes.
