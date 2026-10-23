import { randomInt } from "node:crypto";

/**
 * Liwip BGV Card numbers: `LW`, the two-digit year the case opened, then eight characters from
 * Crockford's base 32 (digits and letters, without I, L, O and U, which read as 1, 1, 0 and V).
 * Stored without spaces (`LW267KQ4M9XT`), shown in groups (`LW 26 7KQ4 M9XT`). 32^8 is about
 * 1.1 trillion numbers a year. Cards issued before this format keep their `LIWIP-YYYY-…` numbers.
 */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CURRENT = /^LW(\d{2})([0-9A-HJKMNP-TV-Z]{8})$/;
const LEGACY = /^[A-Z0-9][A-Z0-9-]{5,39}$/;

export function newCardNumber(at = new Date(), random: (max: number) => number = randomInt): string {
  const year = String(at.getUTCFullYear() % 100).padStart(2, "0");
  let tail = "";
  for (let i = 0; i < 8; i += 1) tail += ALPHABET[random(ALPHABET.length)];
  return `LW${year}${tail}`;
}

/**
 * The stored form of a number someone typed or scanned, or undefined when it can't be one.
 * Spaces and hyphens are ignored in the current format, and the lookalike letters O, I and L in
 * its last eight characters read as the digits they are mistaken for.
 */
export function canonicalCardNumber(value: unknown): string | undefined {
  const typed = String(value ?? "").trim().toUpperCase();
  const compact = typed.replace(/[\s-]/g, "");
  if (/^LW\d{2}[0-9A-Z]{8}$/.test(compact)) {
    const tail = compact.slice(4).replace(/O/g, "0").replace(/[IL]/g, "1");
    const candidate = compact.slice(0, 4) + tail;
    if (CURRENT.test(candidate)) return candidate;
  }
  return LEGACY.test(typed) ? typed : undefined;
}

/** `LW267KQ4M9XT` → `LW 26 7KQ4 M9XT`. Older numbers are returned as they are. */
export function formatCardNumber(cardNumber: string): string {
  const match = CURRENT.exec(cardNumber);
  return match ? `LW ${match[1]} ${match[2].slice(0, 4)} ${match[2].slice(4)}` : cardNumber;
}
