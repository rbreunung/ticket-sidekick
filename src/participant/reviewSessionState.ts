export interface ParsedPrUrl {
  project: string;
  repo: string;
  prId: number;
}

export interface FileDiff {
  path: string;
  diff: string;
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

export function parseDiff(raw: string): FileDiff[] {
  const results: FileDiff[] = [];
  const parts = raw.split(/(?=diff --git )/);
  for (const part of parts) {
    if (!part.trim()) continue;
    const pathMatch = part.match(/\+\+\+ b\/([^\r\n]+)/);
    if (!pathMatch) continue;
    results.push({ path: pathMatch[1].trim(), diff: part });
  }
  return results;
}

export function extractJsonObject(raw: string): string | null {
  // Strip markdown code fence when model wraps output in ```json ... ```
  const fenced = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  const text = fenced ? fenced[1] : raw;

  // Bracket-count from the first { to its matching } — handles trailing text
  // that contains extra braces (which the greedy /\{[\s\S]*\}/ gets wrong).
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (inString && ch === '\\') { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (!inString) {
      if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

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

export function buildAdaptiveChunks(diffs: FileDiff[], tokenBudget: number): FileDiff[][] {
  if (diffs.length === 0) return [];
  const chunks: FileDiff[][] = [];
  let currentChunk: FileDiff[] = [];
  let currentTokens = CHUNK_FIXED_OVERHEAD;

  for (const diff of diffs) {
    const fileTokens = CHUNK_FILE_OVERHEAD + Math.ceil(diff.diff.length / 4);
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
