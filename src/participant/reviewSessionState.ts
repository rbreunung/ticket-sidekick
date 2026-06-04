export interface ParsedPrUrl {
  project: string;
  repo: string;
  prId: number;
}

export interface FileDiff {
  path: string;
  diff: string;
  /** True when the file is removed in this PR (destination is /dev/null). */
  deleted?: boolean;
}

export interface ReviewFinding {
  id: number;
  file: string;
  line?: number;
  lineType?: 'ADDED' | 'CONTEXT' | 'REMOVED';
  fileType?: 'TO' | 'FROM';
  severity: 'critical' | 'warning' | 'suggestion';
  title: string;
  description: string;
  recommendation: string;
  codeExample?: string;
}

export interface ReviewSession {
  prTitle: string;
  prUrl: string;
  project: string;
  repo: string;
  prId: number;
  findings: ReviewFinding[];
}

export interface BitbucketCommentPreviewSession {
  project: string;
  repo: string;
  prId: number;
  items: Array<{ finding: ReviewFinding; text: string }>;
}

export function hasPrUrl(prompt: string): boolean {
  return /https?:\/\/\S+\/pull-requests\/\d+/.test(prompt);
}

export function parsePrUrl(url: string): ParsedPrUrl | null {
  try {
    const u = new URL(url);
    if (u.hostname === 'bitbucket.org') {
      const m = u.pathname.match(/^\/([^/]+)\/([^/]+)\/pull-requests\/(\d+)/);
      if (!m) return null;
      return { project: m[1], repo: m[2], prId: parseInt(m[3], 10) };
    }
    const m = u.pathname.match(/\/projects\/([^/]+)\/repos\/([^/]+)\/pull-requests\/(\d+)/);
    if (!m) return null;
    return { project: m[1], repo: m[2], prId: parseInt(m[3], 10) };
  } catch {
    return null;
  }
}

const stripABPrefix = (p: string): string => p.replace(/^[ab]\//, '').trim();

export function parseDiff(raw: string): FileDiff[] {
  const results: FileDiff[] = [];
  const parts = raw.split(/(?=diff --git )/);
  for (const part of parts) {
    if (!part.trim()) continue;
    // Use the header `--- ` / `+++ ` lines (first occurrence = the file header, before any
    // hunk content). The `+++ ` line names the new file; on a deletion it is `/dev/null`,
    // so fall back to the `--- ` (source) path and flag the file as deleted. This keeps
    // removed files in the review instead of silently dropping them.
    const plus = part.match(/(?:^|[\r\n])\+\+\+ ([^\r\n]+)/)?.[1]?.trim();
    const minus = part.match(/(?:^|[\r\n])--- ([^\r\n]+)/)?.[1]?.trim();
    let path: string | undefined;
    let deleted = false;
    if (plus && plus !== '/dev/null') {
      path = stripABPrefix(plus);
    } else if (plus === '/dev/null' && minus && minus !== '/dev/null') {
      path = stripABPrefix(minus);
      deleted = true;
    } else {
      // No usable +++/--- lines (e.g. a pure rename or mode-only change): take the
      // destination path from the `diff --git a/… b/…` header as a last resort.
      const header = part.match(/(?:^|[\r\n])diff --git .+ b\/([^\r\n]+)/)?.[1];
      if (header) path = header.trim();
    }
    if (!path) continue;
    results.push(deleted ? { path, diff: part, deleted: true } : { path, diff: part });
  }
  return results;
}

// Shared with the Jira intent parser; defined in src/utils so neither participant
// depends on the other. Re-exported here to keep existing import sites unchanged.
export { extractJsonObject } from '../utils/extractJsonObject';

export function extractPartialFindings(raw: string): Array<Record<string, unknown>> {
  const arrayIdx = raw.indexOf('"findings":[');
  if (arrayIdx === -1) return [];
  let i = raw.indexOf('[', arrayIdx) + 1;
  const results: Array<Record<string, unknown>> = [];
  while (i < raw.length) {
    while (i < raw.length && /\s/.test(raw[i])) i++;
    if (i >= raw.length || raw[i] !== '{') break;
    let depth = 0, inStr = false, esc = false, j = i;
    for (; j < raw.length; j++) {
      const ch = raw[j];
      if (esc) { esc = false; continue; }
      if (inStr && ch === '\\') { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (!inStr) { if (ch === '{') depth++; else if (ch === '}' && --depth === 0) break; }
    }
    if (depth !== 0) break;
    try { results.push(JSON.parse(raw.slice(i, j + 1))); } catch { break; }
    i = j + 1;
    while (i < raw.length && (raw[i] === ',' || /\s/.test(raw[i]))) i++;
  }
  return results;
}

export function parseNdjsonFindings(raw: string): {
  findings: Array<Record<string, unknown>>;
  additionalFilesNeeded: string[];
  hasMetaLine: boolean;
  truncated: boolean;
} {
  const findings: Array<Record<string, unknown>> = [];
  let additionalFilesNeeded: string[] = [];
  let hasMetaLine = false;
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const obj = JSON.parse(t) as Record<string, unknown>;
      if (Array.isArray(obj.additionalFilesNeeded) && Object.keys(obj).length === 1) {
        additionalFilesNeeded = obj.additionalFilesNeeded as string[];
        hasMetaLine = true;
      } else if (typeof obj.file === 'string') {
        findings.push(obj);
      }
    } catch { /* incomplete last line */ }
  }
  return {
    findings,
    additionalFilesNeeded,
    hasMetaLine,
    truncated: !hasMetaLine && (findings.length > 0 || raw.trim().length > 0),
  };
}

export function resolveByNumber(message: string, findings: ReviewFinding[]): ReviewFinding | null {
  const m = message.match(/#(\d+)/);
  if (!m) return null;
  const id = parseInt(m[1], 10);
  return findings.find((f) => f.id === id) ?? null;
}

export function resolveByNumbers(message: string, findings: ReviewFinding[]): ReviewFinding[] {
  const ids = new Set([...message.matchAll(/#(\d+)/g)].map((m) => parseInt(m[1], 10)));
  if (ids.size === 0) return [];
  return findings.filter((f) => ids.has(f.id));
}

export function isAddToReviewIntent(message: string): boolean {
  return /\badd\b/i.test(message) && /\breview\b/i.test(message) && /#\d+/.test(message);
}

export function extractUserNote(message: string): string {
  return message
    .replace(/#\d+/g, '')
    .replace(/\badd\b|\bto\b|\breview\b/gi, '')
    .replace(/[,;]+/g, '')
    .trim();
}

export function resolveLineType(
  diff: string,
  lineNumber: number,
): { lineType: 'ADDED' | 'CONTEXT'; fileType: 'TO' } | { lineType: 'REMOVED'; fileType: 'FROM' } | null {
  let fromLine = 0;
  let toLine = 0;
  // TO-side match (ADDED/CONTEXT) takes priority over FROM-side (REMOVED) when both share
  // the same line number (i.e. a line was replaced: -old +new at the same position).
  let removedMatch: { lineType: 'REMOVED'; fileType: 'FROM' } | null = null;
  for (const raw of diff.split('\n')) {
    const hunk = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) { fromLine = parseInt(hunk[1], 10); toLine = parseInt(hunk[2], 10); continue; }
    if (raw.startsWith('diff ') || raw.startsWith('index ') || raw.startsWith('--- ') || raw.startsWith('+++ ') || raw.startsWith('\\')) continue;
    if (fromLine === 0 && toLine === 0) continue;
    if (raw.startsWith('+')) {
      if (toLine === lineNumber) return { lineType: 'ADDED', fileType: 'TO' };
      toLine++;
    } else if (raw.startsWith('-')) {
      if (fromLine === lineNumber) removedMatch = { lineType: 'REMOVED', fileType: 'FROM' };
      fromLine++;
    } else if (raw.startsWith(' ')) {
      if (toLine === lineNumber) return { lineType: 'CONTEXT', fileType: 'TO' };
      fromLine++;
      toLine++;
    }
  }
  return removedMatch;
}

export function annotateWithLineTypes(
  findings: Array<Omit<ReviewFinding, 'id'>>,
  diffs: FileDiff[],
): Array<Omit<ReviewFinding, 'id'>> {
  return findings.map(f => {
    if (f.line === undefined) return f;
    const fileDiff = diffs.find(d => d.path === f.file);
    if (!fileDiff) return f;
    const resolved = resolveLineType(fileDiff.diff, f.line);
    return resolved ? { ...f, lineType: resolved.lineType, fileType: resolved.fileType } : f;
  });
}

export function langFromPath(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    py: 'python', java: 'java', kt: 'kotlin', cs: 'csharp', go: 'go',
    rs: 'rust', rb: 'ruby', php: 'php', swift: 'swift', c: 'c', cpp: 'cpp',
    json: 'json', yaml: 'yaml', yml: 'yaml', sh: 'bash', html: 'html', css: 'css', sql: 'sql',
  };
  return map[ext] ?? '';
}

const CHUNK_FIXED_OVERHEAD = 1500;
const CHUNK_FILE_OVERHEAD = 50;

const estimateFileTokens = (diff: string): number => CHUNK_FILE_OVERHEAD + Math.ceil(diff.length / 4);

/**
 * Split a single file diff that is too large to fit a chunk into smaller sub-diffs along
 * `@@` hunk boundaries. Each sub-diff keeps the original `diff --git`/`---`/`+++` header so
 * it parses and annotates exactly like a normal file diff; findings re-merge by path in
 * `formatReview`. A file with zero or one hunk cannot be subdivided and is returned as-is.
 */
function splitFileDiff(fd: FileDiff, maxFileTokens: number): FileDiff[] {
  if (estimateFileTokens(fd.diff) <= maxFileTokens) return [fd];

  const lines = fd.diff.split('\n');
  const hunkStarts: number[] = [];
  lines.forEach((l, i) => { if (/^@@ /.test(l)) hunkStarts.push(i); });
  if (hunkStarts.length <= 1) return [fd]; // nothing to subdivide

  const header = lines.slice(0, hunkStarts[0]).join('\n');
  const headerTokens = Math.ceil((header.length + 1) / 4);
  const hunks = hunkStarts.map((start, h) => {
    const end = h + 1 < hunkStarts.length ? hunkStarts[h + 1] : lines.length;
    return lines.slice(start, end).join('\n');
  });

  const pieces: FileDiff[] = [];
  let current: string[] = [];
  let currentTokens = CHUNK_FILE_OVERHEAD + headerTokens;
  const flush = () => {
    if (current.length === 0) return;
    const diff = `${header}\n${current.join('\n')}`;
    pieces.push(fd.deleted ? { path: fd.path, diff, deleted: true } : { path: fd.path, diff });
    current = [];
    currentTokens = CHUNK_FILE_OVERHEAD + headerTokens;
  };
  for (const hunk of hunks) {
    const t = Math.ceil((hunk.length + 1) / 4);
    if (current.length > 0 && currentTokens + t > maxFileTokens) flush();
    current.push(hunk);
    currentTokens += t;
  }
  flush();
  return pieces.length > 0 ? pieces : [fd];
}

export function buildAdaptiveChunks(diffs: FileDiff[], tokenBudget: number): FileDiff[][] {
  if (diffs.length === 0) return [];
  // A file must share a chunk with the fixed overhead, so its own budget is what remains.
  const maxFileTokens = tokenBudget - CHUNK_FIXED_OVERHEAD;
  const expanded = maxFileTokens > 0
    ? diffs.flatMap((d) => splitFileDiff(d, maxFileTokens))
    : diffs;

  const chunks: FileDiff[][] = [];
  let currentChunk: FileDiff[] = [];
  let currentTokens = CHUNK_FIXED_OVERHEAD;

  for (const diff of expanded) {
    const fileTokens = estimateFileTokens(diff.diff);
    if (currentChunk.length > 0 && currentTokens + fileTokens > tokenBudget) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentTokens = CHUNK_FIXED_OVERHEAD;
    }
    currentChunk.push(diff);
    currentTokens += fileTokens;
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }
  return chunks;
}
