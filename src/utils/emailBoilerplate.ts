// Pure, vscode-free boilerplate detection over an email's converted Markdown body (parseEmlFile()'s
// markdownBody). The body is split into one segment per message in the thread (reply headers are the
// boundaries), configured phrases are matched inside each segment's body, and each match is widened
// into a block by the extent rules below. Line indices everywhere refer to `markdownBody.split('\n')`.

export type BoilerplateKind = 'header' | 'footer' | 'signature';

// One entry of the ticketSidekick.email.boilerplatePatterns setting: plain phrases, never regexes.
export interface BoilerplatePattern {
  kind: BoilerplateKind;
  start: string;
  end?: string;
}

export type BlockSource = 'pattern' | 'model';

// A phrase pair to locate, tagged with where it came from — configured patterns and verified
// model quotes go through the same locator so their blocks are placed and deduplicated together.
export interface BlockSpec extends BoilerplatePattern {
  source: BlockSource;
  patternIndex?: number;
}

// One message of the thread. startLine..endLine (inclusive) covers the whole message including its
// reply header; bodyStartLine is the first line after the header (== startLine for the top message).
export interface MessageSegment {
  index: number;
  startLine: number;
  endLine: number;
  bodyStartLine: number;
  senderName?: string;
}

export interface DetectedBlock {
  kind: BoilerplateKind;
  segmentIndex: number;
  startLine: number; // inclusive
  endLine: number; // inclusive
  excerpt: string; // first non-empty line, trimmed
  nonEmptyLineCount: number;
  capped: boolean; // stopped by BLOCK_LINE_CAP rather than a natural boundary
  source: BlockSource;
  patternIndex?: number;
}

// Longest block (in non-empty lines) an entry without end phrase may produce.
export const BLOCK_LINE_CAP = 40;

// Case-insensitive, whitespace-collapsed, Markdown emphasis markers (`*`, `_`) removed.
export function normalizePhrase(text: string): string {
  return text.replace(/[*_]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

const SEPARATOR_LINE =
  /^[*_\s]*-{2,}\s*(?:original message|ursprüngliche nachricht|forwarded message|weitergeleitete nachricht)\s*-{2,}[*_\s]*$/i;
const UNDERSCORE_RULE = /^\s*_{10,}\s*$/;
const FROM_LINE = /^[*_\s]*(?:from|von)\s*:[*_]*\s*(.*)$/i;
const HEADER_FIELD = /^[*_\s]*(sent|date|gesendet|datum|to|an|cc|bcc|subject|betreff)\s*:/i;
const MAX_HEADER_LINES = 8;

interface Boundary {
  startLine: number;
  bodyStartLine: number;
  senderName?: string;
}

function isBlank(line: string): boolean {
  return line.trim() === '';
}

// "Bob Middle <bob@x>", "\"Middle, Bob\" [mailto:bob@x]", "bob@x" → display name or undefined.
function parseSenderName(value: string): string | undefined {
  const name = value
    .replace(/[*_]/g, '')
    .replace(/<[^>]*>/g, '')
    .replace(/\[mailto:[^\]]*\]/gi, '')
    .replace(/^["'\s]+|["'\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!name || name.includes('@')) return undefined;
  return name;
}

// A From:/Von: line followed (without a blank line) by Sent|Date and To|Subject fields.
// Returns the last header line index and the parsed sender, or undefined when not a reply header.
function readReplyHeader(lines: string[], i: number): { endLine: number; senderName?: string } | undefined {
  const from = FROM_LINE.exec(lines[i] ?? '');
  if (!from) return undefined;
  let hasDate = false;
  let hasToOrSubject = false;
  let endLine = i;
  for (let j = i + 1; j < lines.length && j <= i + MAX_HEADER_LINES; j++) {
    const field = HEADER_FIELD.exec(lines[j]);
    if (!field) break;
    const key = field[1].toLowerCase();
    if (['sent', 'date', 'gesendet', 'datum'].includes(key)) hasDate = true;
    if (['to', 'an', 'subject', 'betreff'].includes(key)) hasToOrSubject = true;
    endLine = j;
  }
  if (!hasDate || !hasToOrSubject) return undefined;
  return { endLine, senderName: parseSenderName(from[1]) };
}

function findBoundaries(lines: string[]): Boundary[] {
  const boundaries: Boundary[] = [];
  for (let i = 0; i < lines.length; i++) {
    const isSeparator = SEPARATOR_LINE.test(lines[i]);
    const isRule = UNDERSCORE_RULE.test(lines[i]);
    if (isSeparator || isRule) {
      // A separator or OWA underscore rule directly followed by a reply header belongs to it
      let k = i + 1;
      while (k < lines.length && isBlank(lines[k]) && k <= i + 2) k++;
      const header = readReplyHeader(lines, k);
      if (header) {
        boundaries.push({ startLine: i, bodyStartLine: header.endLine + 1, senderName: header.senderName });
        i = header.endLine;
        continue;
      }
      if (isSeparator) {
        boundaries.push({ startLine: i, bodyStartLine: i + 1 });
        continue;
      }
    }
    const header = readReplyHeader(lines, i);
    if (header) {
      boundaries.push({ startLine: i, bodyStartLine: header.endLine + 1, senderName: header.senderName });
      i = header.endLine;
    }
  }
  return boundaries;
}

// Splits the body into one segment per message. The top message's sender comes from the caller
// (the .eml's From header); quoted messages take theirs from their reply header.
export function splitSegments(markdownBody: string, topSenderName?: string): MessageSegment[] {
  const lines = markdownBody.split('\n');
  const boundaries = findBoundaries(lines);
  const segments: MessageSegment[] = [];
  if (boundaries.length === 0 || boundaries[0].startLine > 0) {
    segments.push({ index: 0, startLine: 0, endLine: -1, bodyStartLine: 0, senderName: topSenderName });
  }
  for (const b of boundaries) {
    segments.push({
      index: segments.length,
      startLine: b.startLine,
      endLine: -1,
      bodyStartLine: Math.min(b.bodyStartLine, lines.length),
      senderName: b.senderName,
    });
  }
  for (let i = 0; i < segments.length; i++) {
    segments[i].endLine = i + 1 < segments.length ? segments[i + 1].startLine - 1 : lines.length - 1;
  }
  return segments;
}

interface Candidate {
  spec: BlockSpec;
  segment: MessageSegment;
  startLine: number;
  endLine?: number; // fixed by an end phrase
  order: number; // entry order, the tie-breaker for two entries starting on the same line
}

// The segment body's non-empty lines, normalized and joined by single spaces, with the line each
// character came from — so a phrase can wrap across a line break.
function normalizedSegmentText(lines: string[], segment: MessageSegment): { text: string; lineAt: (pos: number) => number } {
  const parts: string[] = [];
  const offsets: { start: number; line: number }[] = [];
  let length = 0;
  for (let i = segment.bodyStartLine; i <= segment.endLine; i++) {
    const n = normalizePhrase(lines[i]);
    if (!n) continue;
    if (parts.length) length += 1;
    offsets.push({ start: length, line: i });
    parts.push(n);
    length += n.length;
  }
  const lineAt = (pos: number): number => {
    let line = offsets[0].line;
    for (const o of offsets) {
      if (o.start > pos) break;
      line = o.line;
    }
    return line;
  };
  return { text: parts.join(' '), lineAt };
}

function findCandidates(lines: string[], segments: MessageSegment[], specs: BlockSpec[]): Candidate[] {
  const candidates: Candidate[] = [];
  for (const segment of segments) {
    if (segment.bodyStartLine > segment.endLine) continue;
    const { text, lineAt } = normalizedSegmentText(lines, segment);
    if (!text) continue;
    specs.forEach((spec, order) => {
      const start = normalizePhrase(spec.start);
      if (!start) return;
      const end = spec.end !== undefined ? normalizePhrase(spec.end) : '';
      let from = 0;
      for (;;) {
        const s = text.indexOf(start, from);
        if (s < 0) break;
        if (end) {
          const e = text.indexOf(end, s + start.length);
          if (e < 0) break; // no end phrase after this start in this segment: no block here
          candidates.push({ spec, segment, startLine: lineAt(s), endLine: lineAt(e + end.length - 1), order });
          from = e + end.length;
        } else {
          candidates.push({ spec, segment, startLine: lineAt(s), order });
          from = s + start.length;
        }
      }
    });
  }
  return candidates.sort((a, b) => a.startLine - b.startLine || a.order - b.order);
}

// Walks forward from startLine up to limitLine (inclusive), stopping after BLOCK_LINE_CAP non-empty lines.
function capExtent(lines: string[], startLine: number, limitLine: number): { endLine: number; capped: boolean } {
  let count = 0;
  for (let i = startLine; i <= limitLine; i++) {
    if (isBlank(lines[i])) continue;
    count++;
    if (count === BLOCK_LINE_CAP) {
      const rest = lines.slice(i + 1, limitLine + 1).some(l => !isBlank(l));
      return { endLine: i, capped: rest };
    }
  }
  return { endLine: limitLine, capped: false };
}

function trimTrailingBlank(lines: string[], startLine: number, endLine: number): number {
  while (endLine > startLine && isBlank(lines[endLine])) endLine--;
  return endLine;
}

function makeBlock(lines: string[], c: Candidate, startLine: number, endLine: number, capped: boolean): DetectedBlock {
  const slice = lines.slice(startLine, endLine + 1);
  const nonEmpty = slice.filter(l => !isBlank(l));
  const block: DetectedBlock = {
    kind: c.spec.kind,
    segmentIndex: c.segment.index,
    startLine,
    endLine,
    excerpt: (nonEmpty[0] ?? '').trim(),
    nonEmptyLineCount: nonEmpty.length,
    capped,
    source: c.spec.source,
  };
  if (c.spec.patternIndex !== undefined) block.patternIndex = c.spec.patternIndex;
  return block;
}

// Locates every occurrence of every entry in every segment and applies the extent rules:
//  - with `end`: start line through the line holding the end phrase (same segment only);
//  - header without `end`: its paragraph (bounded by blank lines);
//  - footer/signature without `end`: until the next matched block's start or the segment end;
//  - without `end`, at most BLOCK_LINE_CAP non-empty lines (capped = true when that cut it short).
// Blocks never overlap: a candidate starting inside an already accepted block is dropped.
export function detectBlocks(markdownBody: string, specs: BlockSpec[], topSenderName?: string): DetectedBlock[] {
  if (!markdownBody || specs.length === 0) return [];
  const lines = markdownBody.split('\n');
  const segments = splitSegments(markdownBody, topSenderName);
  const candidates = findCandidates(lines, segments, specs);
  const blocks: DetectedBlock[] = [];
  let lastEnd = -1;
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (c.startLine <= lastEnd) continue;
    const seg = c.segment;
    let startLine = c.startLine;
    let endLine: number;
    let capped = false;
    if (c.endLine !== undefined) {
      endLine = c.endLine;
    } else {
      const next = candidates.slice(i + 1).find(o => o.segment === seg && o.startLine > c.startLine);
      let limit = next ? next.startLine - 1 : seg.endLine;
      if (c.spec.kind === 'header') {
        while (startLine > Math.max(seg.bodyStartLine, lastEnd + 1) && !isBlank(lines[startLine - 1])) startLine--;
        let paraEnd = c.startLine;
        while (paraEnd + 1 <= limit && !isBlank(lines[paraEnd + 1])) paraEnd++;
        limit = paraEnd;
      }
      const extent = capExtent(lines, startLine, limit);
      endLine = trimTrailingBlank(lines, startLine, extent.endLine);
      capped = extent.capped;
    }
    blocks.push(makeBlock(lines, c, startLine, endLine, capped));
    lastEnd = endLine;
  }
  return blocks;
}

// Detection for the configured patterns (R2): each block records the index of the entry that found it.
export function detectPatternBlocks(markdownBody: string, patterns: BoilerplatePattern[], topSenderName?: string): DetectedBlock[] {
  return detectBlocks(
    markdownBody,
    patterns.map((p, patternIndex) => ({ kind: p.kind, start: p.start, end: p.end, source: 'pattern' as const, patternIndex })),
    topSenderName,
  );
}
