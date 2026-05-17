export interface ParsedPrUrl {
  authType: 'datacenter' | 'cloud';
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
      return { authType: 'cloud', project: m[1], repo: m[2], prId: parseInt(m[3], 10) };
    }
    const m = u.pathname.match(/\/projects\/([^/]+)\/repos\/([^/]+)\/pull-requests\/(\d+)/);
    if (!m) return null;
    return { authType: 'datacenter', project: m[1], repo: m[2], prId: parseInt(m[3], 10) };
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

export function resolveByNumber(message: string, findings: ReviewFinding[]): ReviewFinding | null {
  const m = message.match(/#(\d+)/);
  if (!m) return null;
  const id = parseInt(m[1], 10);
  return findings.find((f) => f.id === id) ?? null;
}
