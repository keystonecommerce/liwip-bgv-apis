import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalCardNumber, formatCardNumber, newCardNumber } from "../../apps/verification-api/src/domain/card-number";

test("new card numbers are LW, the two-digit year and eight Crockford characters", () => {
  const at = new Date("2026-10-23T10:00:00Z");
  for (let i = 0; i < 200; i += 1) assert.match(newCardNumber(at), /^LW26[0-9A-HJKMNP-TV-Z]{8}$/);
  assert.equal(newCardNumber(new Date("2031-01-01T00:00:00Z"), () => 0), "LW3100000000");
  assert.equal(newCardNumber(at, () => 31), "LW26ZZZZZZZZ");
});

test("typed numbers find the stored form, ignoring spaces, hyphens, case and lookalike letters", () => {
  assert.equal(canonicalCardNumber("LW 26 7KQ4 M9XT"), "LW267KQ4M9XT");
  assert.equal(canonicalCardNumber("  lw26-7kq4-m9xt "), "LW267KQ4M9XT");
  assert.equal(canonicalCardNumber("LW 26 7KQ4 M9XO"), "LW267KQ4M9X0");
  assert.equal(canonicalCardNumber("LW 26 7KQI M9XL"), "LW267KQ1M9X1");
});

test("older LIWIP numbers still look up as they are; nonsense does not", () => {
  assert.equal(canonicalCardNumber("liwip-2026-abcdef1234"), "LIWIP-2026-ABCDEF1234");
  assert.equal(canonicalCardNumber(""), undefined);
  assert.equal(canonicalCardNumber("LW 26 7KQ4"), undefined);
  assert.equal(canonicalCardNumber("<script>"), undefined);
});

test("stored numbers show in groups", () => {
  assert.equal(formatCardNumber("LW267KQ4M9XT"), "LW 26 7KQ4 M9XT");
  assert.equal(formatCardNumber("LIWIP-2026-ABCDEF1234"), "LIWIP-2026-ABCDEF1234");
});
