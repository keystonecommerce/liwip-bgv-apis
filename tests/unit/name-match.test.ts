import assert from "node:assert/strict";
import { test } from "node:test";
import { matchesAnyName, nameAnchors, namesMatch, namesShareWord, panReferenceNames } from "../../apps/verification-api/src/domain/name-match";

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

test("Aadhaar initial matches the expanded PAN name in any order", () => {
  assert.ok(namesMatch("Sanjay M", "MANJUNATHA SANJAY"));
});

test("anchors take Aadhaar and a PAN that fits it", () => {
  const anchors = nameAnchors({
    aadhaar: { name: "Sanjay M", dateOfBirth: "1995-04-12" },
    pan: { name: "MANJUNATHA SANJAY", dateOfBirth: "1995-04-13" }
  });
  assert.deepEqual(anchors, { names: ["Sanjay M", "MANJUNATHA SANJAY"], dateOfBirth: "1995-04-12", official: true });
});

test("anchors leave out a PAN name that does not fit Aadhaar", () => {
  const anchors = nameAnchors({ aadhaar: { name: "Sanjay M", dateOfBirth: "1995-04-12" }, pan: { name: "ANIL KAPOOR", dateOfBirth: "1960-01-01" } });
  assert.deepEqual(anchors, { names: ["Sanjay M"], dateOfBirth: "1995-04-12", official: true });
});

test("anchors use the PAN alone when there is no Aadhaar", () => {
  const anchors = nameAnchors({ pan: { name: "MANJUNATHA SANJAY", dateOfBirth: "1995-04-12" } });
  assert.deepEqual(anchors, { names: ["MANJUNATHA SANJAY"], dateOfBirth: "1995-04-12", official: true });
});

test("no registry record means no anchors", () => {
  assert.deepEqual(nameAnchors({}), { names: [], dateOfBirth: undefined, official: false });
  assert.deepEqual(nameAnchors({ aadhaar: null, pan: null }), { names: [], dateOfBirth: undefined, official: false });
});

test("PAN reference names need a verified Aadhaar", () => {
  assert.deepEqual(panReferenceNames(undefined, "Anything"), []);
  assert.deepEqual(panReferenceNames("Sanjay M", "Manjunatha Sanjay"), ["Sanjay M", "Manjunatha Sanjay"]);
  assert.deepEqual(panReferenceNames("Sanjay M", "Ravi Kumar"), ["Sanjay M"]);
});

test("loose matching accepts a shared full word", () => {
  assert.ok(matchesAnyName("SANJAY KUMAR M", ["Sanjay M"], { loose: true }));
  // Strict rule also accepts it: one extra middle name, SANJAY exact, M exact.
  assert.equal(matchesAnyName("SANJAY KUMAR M", ["Sanjay M"]), namesMatch("SANJAY KUMAR M", "Sanjay M"));
  assert.ok(matchesAnyName("SANJAY KUMAR M", ["Sanjay M"]));
});

test("loose matching still needs a full word in common", () => {
  assert.equal(matchesAnyName("PAVAN KUMAR T M", ["Sanjay M"], { loose: true }), false);
  assert.equal(namesShareWord("M SANJAY", "S M"), false);
});
