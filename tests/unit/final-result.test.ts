import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { explainResult, finalResultFor, onFailFor } from "../../apps/verification-api/src/domain/final-result";
import { decryptSecret, encryptSecret, newWebhookSecret, signatureHeader } from "../../apps/verification-api/src/modules/webhooks/webhook-secrets";
import { webhookUrl } from "../../apps/verification-api/src/modules/webhooks/webhook-url";

const rules = [
  { type: "PAN", mode: "REQUIRED" },
  { type: "REFERENCE_CHECK", mode: "OPTIONAL" },
  { type: "EDUCATION", mode: "OPTIONAL", onFail: "IGNORE" },
  { type: "ECOURTS_SEARCH", mode: "REQUIRED", onFail: "REVIEW" }
];

test("no final result while a check is waiting or running", () => {
  assert.equal(finalResultFor([], rules), null);
  assert.equal(finalResultFor([{ type: "PAN", status: "VERIFIED" }, { type: "REFERENCE_CHECK", status: "PROCESSING" }], rules), null);
});

test("each check's rule decides what its failure means", () => {
  assert.equal(onFailFor("PAN", rules), "FAIL");
  assert.equal(onFailFor("REFERENCE_CHECK", rules), "REVIEW", "optional checks default to review");
  assert.equal(onFailFor("FACE_MATCH", rules), "FAIL", "checks outside the package count as required");
  assert.equal(finalResultFor([{ type: "PAN", status: "VERIFIED" }, { type: "EDUCATION", status: "FAILED" }], rules), "PASS");
  assert.equal(finalResultFor([{ type: "PAN", status: "VERIFIED" }, { type: "REFERENCE_CHECK", status: "FAILED" }], rules), "REVIEW");
  assert.equal(finalResultFor([{ type: "PAN", status: "VERIFIED" }, { type: "ECOURTS_SEARCH", status: "FAILED" }], rules), "REVIEW");
  assert.equal(finalResultFor([{ type: "PAN", status: "FAILED" }, { type: "REFERENCE_CHECK", status: "MANUAL_REVIEW" }], rules), "FAIL", "fail wins over review");
  assert.equal(finalResultFor([{ type: "PAN", status: "MANUAL_REVIEW" }], rules), "REVIEW");
  assert.deepEqual(explainResult([{ type: "PAN", status: "FAILED" }, { type: "REFERENCE_CHECK", status: "FAILED" }], rules)?.because, [{ type: "PAN", status: "FAILED", effect: "FAIL" }]);
});

test("webhook secrets are encrypted at rest and every body is signed with the timestamp", () => {
  process.env.ADMIN_AUTH_SECRET ||= "unit_test_admin_secret_longer_than_32_chars";
  const previous = process.env.NODE_ENV; process.env.NODE_ENV = "test";
  try {
    const secret = newWebhookSecret();
    assert.match(secret, /^whsec_[A-Za-z0-9_-]{43}$/);
    const stored = encryptSecret(secret);
    assert.ok(!stored.includes(secret.slice(6)));
    assert.equal(decryptSecret(stored), secret);
    const at = new Date("2026-10-22T10:00:00Z");
    const header = signatureHeader(secret, '{"a":1}', at);
    const t = at.getTime() / 1000;
    assert.equal(header, `t=${t},v1=${createHmac("sha256", secret).update(`${t}.{"a":1}`).digest("hex")}`);
  } finally { process.env.NODE_ENV = previous; }
});

test("webhook URLs must be https on a public address", () => {
  assert.equal(webhookUrl("https://hooks.example.com/liwip#x"), "https://hooks.example.com/liwip");
  for (const bad of ["http://hooks.example.com", "https://localhost/x", "https://10.1.2.3/x", "https://192.168.1.5/x", "https://169.254.169.254/latest", "https://[::1]/x", "https://user:pw@hooks.example.com", "not a url"]) {
    assert.throws(() => webhookUrl(bad), /url must/, bad);
  }
});
