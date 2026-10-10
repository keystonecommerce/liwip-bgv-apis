import "reflect-metadata";
import assert from "node:assert/strict";
import { test } from "node:test";
import { workerCardReady } from "../../apps/verification-api/src/modules/verifications/verification.repository";

const check = (type: string, status: string) => ({ type, status });

test("all checks verified", () => {
  assert.equal(workerCardReady([check("AADHAAR", "VERIFIED"), check("PAN", "VERIFIED")]), true);
});

test("a check in manual review does not block the card", () => {
  assert.equal(workerCardReady([check("AADHAAR", "VERIFIED"), check("PAN", "MANUAL_REVIEW")]), true);
});

test("a failed non-Aadhaar check does not block the card", () => {
  assert.equal(workerCardReady([check("AADHAAR", "VERIFIED"), check("DRIVING_LICENSE", "FAILED")]), true);
});

test("a check still running blocks the card", () => {
  for (const status of ["PENDING", "QUEUED", "PROCESSING"]) {
    assert.equal(workerCardReady([check("AADHAAR", "VERIFIED"), check("PAN", status)]), false, status);
  }
});

test("Aadhaar must be verified when present", () => {
  assert.equal(workerCardReady([check("AADHAAR", "FAILED"), check("PAN", "VERIFIED")]), false);
});

test("needs at least one verified check", () => {
  assert.equal(workerCardReady([check("PAN", "MANUAL_REVIEW"), check("DRIVING_LICENSE", "MANUAL_REVIEW")]), false);
  assert.equal(workerCardReady([]), false);
});
