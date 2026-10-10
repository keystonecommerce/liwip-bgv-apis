/**
 * Indian names appear differently across documents: Aadhaar often has initials
 * ("Sanjay M"), PAN the expanded name ("Sanjay Mohan"), a licence may drop a
 * middle name or join two words. Two names match when they plainly refer to
 * the same person; anything less certain goes to a human reviewer.
 */

const TITLES = new Set(["MR", "MRS", "MS", "MISS", "SHRI", "SRI", "SMT", "SHRIMATI", "KUMARI", "KUM", "DR", "MD"]);

export function nameTokens(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return value
    .toUpperCase()
    .normalize("NFKD")
    .replace(/[^A-Z ]/g, " ")
    .split(/\s+/)
    .filter((token) => token && !TITLES.has(token));
}

/** One edit (insert, delete or substitute) apart. */
function oneEditApart(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/** Same word, an initial of it, or a one-letter slip in a long word. */
function tokensAgree(a: string, b: string): "exact" | "initial" | "close" | null {
  if (a === b) return "exact";
  if ((a.length === 1 && b.startsWith(a)) || (b.length === 1 && a.startsWith(b))) return "initial";
  if (a.length >= 5 && b.length >= 5 && oneEditApart(a, b)) return "close";
  return null;
}

export function namesMatch(left: unknown, right: unknown): boolean {
  const a = nameTokens(left);
  const b = nameTokens(right);
  if (!a.length || !b.length) return false;
  // Joined or split words: "MOHAMMEDABDUL RAHMAN" and "MOHAMMED ABDUL RAHMAN".
  if (a.join("") === b.join("")) return true;

  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  // At most one name missing from the shorter side (usually a middle name).
  if (longer.length - shorter.length > 1) return false;
  const unused = [...longer];
  let exact = 0;
  for (const token of shorter) {
    // Prefer an exact partner, then an initial, then a close spelling.
    const ranked = (["exact", "initial", "close"] as const)
      .map((kind) => unused.findIndex((candidate) => tokensAgree(token, candidate) === kind))
      .find((index) => index >= 0);
    if (ranked === undefined) return false;
    if (tokensAgree(token, unused[ranked]) === "exact" && token.length > 1) exact++;
    unused.splice(ranked, 1);
  }
  // At least one full word must be identical, so initials alone never match.
  return exact >= 1;
}

/**
 * Names a document may be matched against: the Aadhaar name, plus the name the
 * worker typed when it fits that Aadhaar name. A typed name that does not fit a
 * verified Aadhaar is ignored, so a worker cannot claim someone else's name.
 */
export function referenceNames(personal: { nameAsAadhaar?: string; declaredName?: string }, aadhaarName?: string): string[] {
  const names = [personal.nameAsAadhaar].filter((name): name is string => Boolean(name));
  const declared = personal.declaredName;
  if (declared && (!aadhaarName || namesMatch(declared, aadhaarName))) names.push(declared);
  return [...new Set(names)];
}

/** True when the returned name matches any of the worker's reference names. */
export function matchesAnyName(returned: unknown, references: unknown[]): boolean {
  return references.some((reference) => namesMatch(returned, reference));
}
