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
  severity: 'critical' | 'warning' | 'suggestion';
  title: string;
  description: string;
  recommendation: string;
}

export interface ReviewSession {
  prTitle: string;
  prUrl: string;
  findings: ReviewFinding[];
}

export function parsePrUrl(url: string, baseUrl: string): ParsedPrUrl | null {
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

export function resolveByNumber(message: string, findings: ReviewFinding[]): ReviewFinding | null {
  const m = message.match(/#(\d+)/);
  if (!m) return null;
  const id = parseInt(m[1], 10);
  return findings.find((f) => f.id === id) ?? null;
}
