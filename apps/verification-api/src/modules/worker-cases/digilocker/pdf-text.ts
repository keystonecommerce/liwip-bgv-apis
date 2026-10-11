/**
 * Plain text of every page, via unpdf (a maintained, dependency-free pdf.js build for Node).
 * Items flagged end-of-line, or that move to a new baseline, start a new line.
 */
export async function pdfText(pdf: Buffer): Promise<string> {
  const { getDocumentProxy } = await import("unpdf");
  const doc = await getDocumentProxy(new Uint8Array(pdf));
  try {
    const pages: string[] = [];
    for (let i = 1; i <= doc.numPages; i += 1) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      let out = "";
      let lastY: number | undefined;
      for (const item of content.items) {
        if (!("str" in item)) continue;
        const y = item.transform[5];
        if (lastY !== undefined && Math.abs(y - lastY) > 1 && !out.endsWith("\n")) out += "\n";
        out += item.str;
        if (item.hasEOL) out += "\n";
        lastY = y;
      }
      pages.push(out);
    }
    return normaliseWhitespace(pages.join("\n"));
  } finally {
    await doc.loadingTask.destroy();
  }
}

function normaliseWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[\t\f\v ]/g, " ").replace(/ {2,}/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/*
 * Line-based filter for text sent to the extraction model.
 *
 * DigiLocker PDFs lay fields out either inline ("Name : RAVI KUMAR") or across lines
 * (label line, a lone ":" line, then one or more value lines). We walk the lines with a single
 * "dropping" flag: a line that starts with a DROP label turns it on, a line that starts with a
 * KEEP label turns it off, and every other line (":" separators, values) follows the current
 * flag. So an address, father's name, etc. is removed together with its value lines up to the
 * next known label. Lone ":" lines and blanks are removed, and everything from the "Note:"
 * boilerplate onwards is dropped.
 */
const DROP_LABELS: RegExp[] = [
  /^.{0,30}\baddress\b/i,
  /^(s\s*\/\s*w\s*\/\s*d|s\s*\/\s*d\s*\/\s*w|son\s*\/\s*daughter|son\s*\/\s*wife|father|husband|guardian|relation)/i,
  /^blood\s*group/i,
  /^chass?is\s*(number|no)/i,
  /^engine\s*(number|no)/i,
  /^(mobile|phone|email|e-mail)/i,
  /^(signature|photo)\b/i
];

const KEEP_LABELS: RegExp[] = [
  /^(driving\s+)?licen[cs]e\s*(no|number)/i,
  /^dl\s*(no|number)/i,
  /^registration\s*(no|number|date)/i,
  /^reg(n|istration)?\.?\s*(no|date)/i,
  /^(owner\s*)?name\b/i,
  /^holder'?s?\s*name/i,
  /^(dob|date\s*of\s*birth)\b/i,
  /^date\s*of\s*(expiry|issue|first\s*issue|registration)/i,
  /^(issue\s*date|expiry\s*date|valid(ity)?(\s*(till|upto|up\s*to|from))?)\b/i,
  /^authori[sz]ation\s*to\s*drive/i,
  /^(vehicle\s*class|class\s*of\s*vehicle|cov)\b/i,
  /^issuing\s*authority/i,
  /^(registering\s*authority|rto)\b/i,
  /^(permanent\s*account\s*number|pan)\b/i,
  /^(gender|sex)\b/i,
  /^(maker|manufacturer|model|fuel|colou?r|body\s*type|vehicle\s*(description|category)|status)\b/i,
  /^(fitness|insurance|tax|puc)\b/i
];

export function trimForExtraction(text: string): string {
  const kept: string[] = [];
  let dropping = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (/^note\s*[:\-]/i.test(line)) break;
    if (!line || /^[:\-]$/.test(line)) continue;
    if (DROP_LABELS.some((re) => re.test(line))) {
      dropping = true;
      continue;
    }
    if (KEEP_LABELS.some((re) => re.test(line))) dropping = false;
    if (!dropping) kept.push(line);
  }
  return kept.join("\n");
}
