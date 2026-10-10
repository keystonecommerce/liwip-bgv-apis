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
 * Looser rule, used only when the registry has already confirmed the worker's
 * date of birth with the document number: the names share at least one full word.
 */
export function namesShareWord(left: unknown, right: unknown): boolean {
  const b = new Set(nameTokens(right).filter((token) => token.length > 1));
  return nameTokens(left).some((token) => token.length > 1 && b.has(token));
}

/** True when the returned name matches any reference name (loosely when the date of birth is confirmed). */
export function matchesAnyName(returned: unknown, references: unknown[], options: { loose?: boolean } = {}): boolean {
  return references.some((reference) => namesMatch(returned, reference) || (options.loose === true && namesShareWord(returned, reference)));
}

/**
 * The official names and date of birth every other document is matched against.
 * Only registry records count: the verified Aadhaar, and a verified PAN whose
 * name fits that Aadhaar (or the PAN alone when Aadhaar was not chosen). Names
 * the worker typed are never references for other documents.
 */
export interface NameAnchors {
  names: string[];
  dateOfBirth?: string;
  /** False when no registry record is verified yet; name matches then go to review. */
  official: boolean;
}

export function nameAnchors(input: {
  aadhaar?: { name?: string; dateOfBirth?: string } | null;
  pan?: { name?: string; dateOfBirth?: string } | null;
}): NameAnchors {
  const aadhaarName = input.aadhaar?.name?.trim();
  const panName = input.pan?.name?.trim();
  const names: string[] = [];
  if (aadhaarName) names.push(aadhaarName);
  if (panName && (!aadhaarName || namesMatch(panName, aadhaarName))) names.push(panName);
  const dateOfBirth = aadhaarName ? input.aadhaar?.dateOfBirth : panName ? input.pan?.dateOfBirth : undefined;
  return { names: [...new Set(names)], dateOfBirth: dateOfBirth || undefined, official: names.length > 0 };
}

/**
 * Names the PAN itself is matched against: the Aadhaar name, plus the full name
 * the worker typed as on PAN when it fits that Aadhaar (it expands initials).
 * Without a verified Aadhaar there is nothing official to match, so none.
 */
export function panReferenceNames(aadhaarName: string | undefined, declaredName: string | undefined): string[] {
  if (!aadhaarName) return [];
  const names = [aadhaarName];
  if (declaredName && namesMatch(declaredName, aadhaarName)) names.push(declaredName);
  return [...new Set(names)];
}
