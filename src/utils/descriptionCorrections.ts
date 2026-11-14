// Applies spell-check corrections a developer approved to a ticket description as Jira stores it
// (wiki markup). Only the listed text changes: the rest of the description, markup included, stays
// as it is, which a round trip through Markdown would not guarantee. Code, monospace, link targets,
// web addresses and images are never corrected, and a correction may not add markup. Pure, so it is tested without Jira or VS Code.

export interface Correction {
  before: string;
  after: string;
}

export type RefusalReason = 'empty' | 'not found' | 'not unique' | 'protected' | 'overlaps' | 'adds markup';

export interface RefusedCorrection {
  /** The correction's position in the list, counted from 1 as the developer saw it. */
  number: number;
  before: string;
  reason: RefusalReason;
}

export type CorrectionResult = { text: string } | { refused: RefusedCorrection[] };

interface Range {
  start: number;
  end: number;
}

const BLOCKS = [
  // One pass over both block kinds, so a literal {code} shown inside a noformat block is never
  // taken for the start of a code block, which would leave the real one after it unprotected.
  /\{(code|noformat)(?::[^}]*)?\}[\s\S]*?\{\1\}/gi,
  /\{\{[\s\S]*?\}\}/g,
  // An image or attachment embed: !file.png! or !file.png|thumbnail!
  /!([^!\s|]+?)(?:\|[^!]*)?!/g,
];
const LINK = /\[([^\]\n]*)\]/g;
const WEB_ADDRESS = /\b[a-z][a-z0-9+.-]*:\/\/[^\s|\]]+/gi;

/** The parts of a description no correction may touch. */
export function protectedRanges(wiki: string): Range[] {
  const ranges: Range[] = [];
  for (const pattern of BLOCKS) {
    for (const m of wiki.matchAll(pattern)) ranges.push({ start: m.index, end: m.index + m[0].length });
  }
  // A link's target: after the last "|" in [text|target], or all of [target]; mentions ([~user]) too.
  for (const m of wiki.matchAll(LINK)) {
    const inner = m[1];
    const innerStart = m.index + 1;
    const pipe = inner.lastIndexOf('|');
    ranges.push({ start: pipe === -1 ? innerStart : innerStart + pipe + 1, end: innerStart + inner.length });
  }
  for (const m of wiki.matchAll(WEB_ADDRESS)) ranges.push({ start: m.index, end: m.index + m[0].length });
  return ranges;
}

const overlaps = (a: Range, b: Range) => a.start < b.end && b.start < a.end;

/** Characters that open wiki markup a spelling fix never needs: images, links, macros, tables. */
const MARKUP_CHARS = ['!', '[', ']', '{', '}', '|'];
const count = (text: string, part: string) => text.split(part).length - 1;

/** Whether `after` brings in markup that `before` did not have, such as an image, a link or a macro. */
function addsMarkup(before: string, after: string): boolean {
  return [...MARKUP_CHARS, '://'].some(part => count(after, part) > count(before, part));
}

/**
 * Applies every correction, or none: when any one is refused, nothing changes and each refused
 * correction is named with the reason, so the developer can drop it and run again.
 */
export function applyCorrections(wiki: string, corrections: readonly Correction[]): CorrectionResult {
  const guarded = protectedRanges(wiki);
  const claimed: Array<Range & { after: string }> = [];
  const refused: RefusedCorrection[] = [];

  corrections.forEach(({ before, after }, i) => {
    const refuse = (reason: RefusalReason) => refused.push({ number: i + 1, before, reason });
    if (!before) return refuse('empty');
    const first = wiki.indexOf(before);
    if (first === -1) return refuse('not found');
    if (wiki.indexOf(before, first + 1) !== -1) return refuse('not unique');
    const range = { start: first, end: first + before.length };
    if (guarded.some(g => overlaps(g, range))) return refuse('protected');
    if (claimed.some(c => overlaps(c, range))) return refuse('overlaps');
    if (addsMarkup(before, after)) return refuse('adds markup');
    claimed.push({ ...range, after });
  });

  if (refused.length > 0) return { refused };
  let text = wiki;
  for (const c of [...claimed].sort((a, b) => b.start - a.start)) {
    text = text.slice(0, c.start) + c.after + text.slice(c.end);
  }
  return { text };
}
