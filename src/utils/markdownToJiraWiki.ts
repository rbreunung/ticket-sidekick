export function markdownToJiraWiki(md: string): string {
  const lines = md.split('\n');
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    const codeOpen = line.match(/^```(\w*)\s*$/);
    if (codeOpen) {
      const lang = codeOpen[1];
      const isNoformat = lang === 'noformat';
      out.push(isNoformat ? '{noformat}' : lang ? `{code:${lang}}` : '{code}');
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        out.push(lines[i]);
        i++;
      }
      out.push(isNoformat ? '{noformat}' : '{code}');
      i++; // skip closing ```
      continue;
    }

    // Heading
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      out.push(`h${heading[1].length}. ${inline(heading[2])}`);
      i++;
      continue;
    }

    // Horizontal rule
    if (/^(\*{3,}|-{3,}|_{3,})$/.test(line.trim())) {
      out.push('----');
      i++;
      continue;
    }

    // Blockquote — collect consecutive > lines into one {quote} block
    if (line.startsWith('> ')) {
      out.push('{quote}');
      while (i < lines.length && lines[i].startsWith('> ')) {
        out.push(inline(lines[i].slice(2)));
        i++;
      }
      out.push('{quote}');
      continue;
    }

    // Unordered list
    const ul = line.match(/^(\s*)[-*+]\s+(.+)$/);
    if (ul) {
      const level = Math.floor(ul[1].length / 2) + 1;
      out.push('*'.repeat(level) + ' ' + inline(ul[2]));
      i++;
      continue;
    }

    // Ordered list
    const ol = line.match(/^(\s*)\d+\.\s+(.+)$/);
    if (ol) {
      const level = Math.floor(ol[1].length / 2) + 1;
      out.push('#'.repeat(level) + ' ' + inline(ol[2]));
      i++;
      continue;
    }

    // Table separator — skip
    if (/^\|[\s\-:|]+\|$/.test(line)) {
      i++;
      continue;
    }

    // Table row
    if (line.startsWith('|') && line.endsWith('|')) {
      const nextLine = lines[i + 1] ?? '';
      const isHeader = /^\|[\s\-:|]+\|$/.test(nextLine);
      const cells = line.slice(1, -1).split('|').map(c => inline(c.trim()));
      out.push(isHeader ? '||' + cells.join('||') + '||' : '|' + cells.join('|') + '|');
      i++;
      continue;
    }

    // Regular line
    out.push(inline(line));
    i++;
  }

  return out.join('\n');
}

// Full union of both trigger-character categories this converter and reportImport.ts each care
// about (KTD4): the Markdown-defeating set (bold/italic/code-span/link markers) and the
// Jira-native set (strikethrough/underline/superscript/citation/macro/image triggers). Data-only —
// consumed two different ways by two different callers, so this constant does not itself encode
// "strip" vs "shape-match" behavior. reportImport.ts's sanitizeCellText() strips every character in
// this set unconditionally from untrusted raw values; this file's inline() neutralizes only the
// Jira-native subset, and only when it actually forms a wrapped shape (see JIRA_TRIGGER_SHAPES
// below) plus unconditional `{`/`}` stripping (KTD3) — never the Markdown-defeating subset, which
// this converter's own regexes already consume correctly.
export const TRIGGER_CHARS = '*_`[]~-+^?{}!';

// A RegExp built from TRIGGER_CHARS, exactly matching reportImport.ts's previous inline literal
// `/[*_`[\]~\-+^?{}!]/g` character-for-character (KTD4) — order/duplication of chars inside a
// character class doesn't change what it matches, only presence/absence does.
export const TRIGGER_CHARS_PATTERN = /[*_`[\]~\-+^?{}!]/g;

// Jira-native wiki-markup trigger shapes that must never survive from untrusted text as a live,
// unconverted trigger (R1/KTD1): -text- (strikethrough), +text+ (underline), ^text^ (superscript),
// ??text?? (citation), !text! (remote image embed — the concrete tracking-pixel exploit named in
// the plan). `_text_` italic is intentionally excluded — Markdown's and Jira's syntax are
// byte-identical there, so there is no conversion step to protect against (R1 scope note).
//
// Only actually-wrapped sequences are neutralized. Each delimiter must sit at a word boundary — not
// immediately preceded (opening) or followed (closing) by a word character, and not immediately
// adjacent to whitespace on the inner side — so ordinary prose is left untouched:
//   - "co-worker", "x^2", "what?", "great!" never have a *second* same-shape delimiter to pair with
//   - "state-of-the-art"/"well-known-issue": every internal hyphen is flanked by letters on both
//     sides, so none of them ever qualifies as an opening OR closing delimiter under the word-
//     boundary rule — a naive `/-text-/` would incorrectly match *between* two such hyphens (e.g.
//     "-of-" inside "state-of-the-art"); requiring word-boundary-adjacent delimiters closes that
//     specific false-positive class without needing to inspect the whole compound word
//   - "Monday - Friday" (spaced hyphen range): the inner-whitespace check rejects it, since a
//     legitimate wrap's content never starts or ends with a space
const JIRA_TRIGGER_SHAPES: ReadonlyArray<{ delimiter: string; char: string }> = [
  { delimiter: '??', char: '?' }, // citation — checked first so its two '?' aren't seen as loose '?' noise
  { delimiter: '-', char: '-' }, // strikethrough
  { delimiter: '+', char: '+' }, // underline
  { delimiter: '^', char: '^' }, // superscript
  { delimiter: '!', char: '!' }, // remote image embed
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildWrapPattern(delimiter: string, char: string): RegExp {
  const d = escapeRegExp(delimiter);
  const c = escapeRegExp(char);
  // (?<!\w) / (?!\w)   — delimiters sit at a word boundary, not inside a run of word characters
  // (?!\s) / (?<!\s)   — content may not start or end with whitespace
  // [^${c}\n]+?        — content excludes the delimiter's own character and newlines, non-greedy
  return new RegExp(`(?<!\\w)${d}(?!\\s)([^${c}\\n]+?)(?<!\\s)${d}(?!\\w)`, 'g');
}

const WRAP_PATTERNS = JIRA_TRIGGER_SHAPES.map(({ delimiter, char }) => buildWrapPattern(delimiter, char));

/**
 * Neutralizes any remaining raw Jira-native wiki-markup trigger left in `text` (R1/KTD1/KTD3).
 * Must run after the converter's own legitimate strikethrough/image output has been extracted
 * out-of-band (KTD2) and before it's restored, so this function only ever sees text the author
 * typed directly — never the converter's own generated `-text-`/`!url!` output.
 */
function neutralizeJiraTriggers(text: string): string {
  for (const pattern of WRAP_PATTERNS) {
    text = text.replace(pattern, (_match, content: string) => content);
  }
  // KTD3: unconditionally strip any remaining raw '{'/'}'. inline() runs once per line/blockquote-
  // line/table-cell — never once over the whole assembled document — so an attacker could split an
  // opening `{quote}`/`{color}`/`{panel}`/`{noformat}` onto one line and its closing counterpart
  // onto a later line (or a different table cell); no single inline() call ever sees both halves
  // together, so shape-pair-matching within one call cannot detect a macro assembled across lines,
  // even though Jira's renderer treats the joined output as one document and would render the
  // joined pair as live. Unconditional per-character removal closes that regardless of where the
  // two halves land. Fenced code blocks and code-span content never reach here — they're handled
  // before this function runs (fenced blocks in markdownToJiraWiki() itself; code spans via the
  // array-indexed extraction above) and always push their own hardcoded macro braces, never
  // attacker text. Accepted low-cost trade-off: a legitimate footnote-style "{1}" in prose also
  // loses its braces — there is no way to distinguish that from an attacker-split macro half within
  // a single line/cell.
  text = text.replace(/[{}]/g, '');
  return text;
}

function inline(text: string): string {
  // Protect inline code spans from further processing
  const spans: string[] = [];
  text = text.replace(/`([^`]+)`/g, (_, code) => {
    spans.push(`{{${code}}}`);
    return `\x00C${spans.length - 1}\x00`;
  });

  // Images before links so ![...](...) is handled first
  // Local URLs (no protocol) → thumbnail syntax; remote URLs → plain syntax
  // Extracted out-of-band into an array (KTD2), mirroring code spans above: this is the only way
  // to later distinguish the converter's OWN legitimate `!url!`/`!url|thumbnail!` output from a raw,
  // attacker-injected `!url!` sequence still sitting in the string when neutralizeJiraTriggers runs.
  const imageSpans: string[] = [];
  text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_match, _alt, url) => {
    const rendered = /^https?:\/\/|^\/\//.test(url) ? `!${url}!` : `!${url}|thumbnail!`;
    imageSpans.push(rendered);
    return `\x00I${imageSpans.length - 1}\x00`;
  });

  // Links
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '[$1|$2]');

  // Bold: ** or __ — use placeholder to avoid italic pass touching it
  text = text.replace(/\*\*(.+?)\*\*/g, '\x00B\x00$1\x00/B\x00');
  text = text.replace(/__(.+?)__/g, '\x00B\x00$1\x00/B\x00');

  // Italic: single * (not part of **)
  text = text.replace(/\*([^*\n]+)\*/g, '_$1_');

  // Strikethrough — extracted out-of-band into an array (KTD2), same rationale as images: the
  // legitimate `-text-` this produces must be reliably distinguishable from a raw, injected `-text-`
  // elsewhere in the same string, which only an out-of-band array lookup (not a content-embedded
  // marker) can guarantee — see AE5 in the test suite for the exact scenario this protects against.
  const strikeSpans: string[] = [];
  text = text.replace(/~~(.+?)~~/g, (_, content) => {
    strikeSpans.push(`-${content}-`);
    return `\x00S${strikeSpans.length - 1}\x00`;
  });

  // Neutralize any remaining raw Jira-native wiki-markup trigger sequences (R1). At this point the
  // only `-text-`/`+text+`/`^text^`/`??text??`/`!text!`-shaped sequences left in the string are ones
  // the author typed directly — legitimate image/strikethrough output is already out-of-band above,
  // and code-span content was extracted before that.
  text = neutralizeJiraTriggers(text);

  // Restore bold
  text = text.replace(/\x00B\x00(.+?)\x00\/B\x00/g, '*$1*');

  // Restore images
  text = text.replace(/\x00I(\d+)\x00/g, (_, idx) => imageSpans[parseInt(idx, 10)]);

  // Restore strikethrough
  text = text.replace(/\x00S(\d+)\x00/g, (_, idx) => strikeSpans[parseInt(idx, 10)]);

  // Restore code spans
  text = text.replace(/\x00C(\d+)\x00/g, (_, idx) => spans[parseInt(idx, 10)]);

  return text;
}
