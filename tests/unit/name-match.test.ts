import assert from "node:assert/strict";
import { test } from "node:test";
import { matchesAnyName, namesMatch } from "../../apps/verification-api/src/domain/name-match";

test("same name in any order, case and punctuation", () => {
  assert.ok(namesMatch("Sanjay Mohan", "MOHAN, SANJAY"));
  assert.ok(namesMatch("Priya  Sharma", "priya sharma."));
});

test("initials match the expanded word", () => {
  assert.ok(namesMatch("Sanjay M", "Sanjay Mohan"));
  assert.ok(namesMatch("K Venkata Ramana", "Kotha Venkata Ramana"));
});

test("titles are ignored", () => {
  assert.ok(namesMatch("Shri Ravi Kumar", "RAVI KUMAR"));
  assert.ok(namesMatch("Dr. Anita Rao", "Anita Rao"));
});

test("one missing middle name is allowed", () => {
  assert.ok(namesMatch("Ravi Kumar", "Ravi Suresh Kumar"));
});

test("joined or split words", () => {
  assert.ok(namesMatch("Mohammedabdul Rahman", "Mohammed Abdul Rahman"));
});

test("one-letter spelling slip in a long word", () => {
  assert.ok(namesMatch("Mohammed Rahman", "Mohamed Rahman"));
});

test("different people do not match", () => {
  assert.equal(namesMatch("Priya Sharma", "Ravi Kumar"), false);
  assert.equal(namesMatch("Sanjay Mohan", "Sanjay Mehta"), false);
});

test("initials alone never match", () => {
  assert.equal(namesMatch("S M", "Sanjay Mohan"), false);
});

test("two or more missing names do not match", () => {
  assert.equal(namesMatch("Ravi", "Ravi Suresh Kumar"), false);
});

test("short words need an exact match", () => {
  assert.equal(namesMatch("Ram Das", "Rao Das"), false);
});

test("empty names never match", () => {
  assert.equal(namesMatch("", "Ravi Kumar"), false);
  assert.equal(namesMatch(undefined, "Ravi Kumar"), false);
});

test("any reference name may match", () => {
  assert.ok(matchesAnyName("SANJAY MOHAN", ["Sanjay M", "Sanjay Mohan"]));
  assert.equal(matchesAnyName("ANIL KAPOOR", ["Sanjay M", "Sanjay Mohan"]), false);
});
