import { XMLParser } from 'fast-xml-parser';

export interface VeracodeFlaw {
  issueId: string;
  severity: number; // 0 (Informational) .. 5 (Very High)
  categoryName: string;
  cweId: string | null;
  cweName: string | null;
  description: string;
  recommendation: string | null;
  module: string;
  sourceFile: string | null;
  sourceFilePath: string | null;
  line: number | null;
  scope: string | null;
  functionPrototype: string | null;
  remediationStatus: string;
}

export const SEVERITY_LABELS = ['Informational', 'Very Low', 'Low', 'Medium', 'High', 'Very High'];

export function severityLabel(severity: number): string {
  return SEVERITY_LABELS[severity] ?? `Severity ${severity}`;
}

const MAX_REPORT_BYTES = 20 * 1024 * 1024; // 20 MB

// Defense-in-depth: fast-xml-parser does not resolve external entities, but we
// reject DOCTYPE/ENTITY declarations outright so a malicious file is never even parsed.
export function assertSafeVeracodeXml(raw: string): void {
  if (Buffer.byteLength(raw, 'utf8') > MAX_REPORT_BYTES) {
    throw new Error(`Veracode report exceeds the ${MAX_REPORT_BYTES / (1024 * 1024)} MB size limit.`);
  }
  if (/<!DOCTYPE/i.test(raw) || /<!ENTITY/i.test(raw)) {
    throw new Error('Veracode report contains a DOCTYPE/ENTITY declaration and was rejected for security reasons.');
  }
}

// Elements that may repeat but fast-xml-parser only arrays when count > 1 — force arrays always.
const ARRAY_TAGS = new Set(['severity', 'category', 'cwe', 'flaw', 'para']);

// issueid must be purely numeric — see the JQL-injection defense note in parseVeracodeReport below.
const ISSUE_ID_PATTERN = /^\d+$/;

function toArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function extractRecommendation(recommendations: unknown): string | null {
  const recs = recommendations as { para?: Array<{ text?: string }> } | undefined;
  const paras = toArray(recs?.para).map(p => p.text).filter((t): t is string => Boolean(t));
  return paras.length > 0 ? paras.join('\n\n') : null;
}

export function parseVeracodeReport(xml: string): VeracodeFlaw[] {
  assertSafeVeracodeXml(xml);

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    isArray: (tagName: string) => ARRAY_TAGS.has(tagName),
  });

  let doc: Record<string, any>;
  try {
    doc = parser.parse(xml);
  } catch (err) {
    throw new Error(`Could not parse Veracode report XML: ${err instanceof Error ? err.message : String(err)}`);
  }

  const report = doc?.detailedreport;
  if (!report) {
    throw new Error('Not a recognizable Veracode Detailed Report (missing <detailedreport> root element).');
  }

  const flaws: VeracodeFlaw[] = [];
  for (const severity of toArray(report.severity)) {
    for (const category of toArray(severity.category)) {
      const recommendation = extractRecommendation(category.recommendations);
      for (const cwe of toArray(category.cwe)) {
        for (const flaw of toArray(cwe.staticflaws?.flaw)) {
          const issueId = String(flaw.issueid);
          // Defense-in-depth: issueId is interpolated directly into JQL later (`labels in (veracode-issue-<id>)`
          // in buildDedupJql, and `veracode-issue-<id>` as a label on the created ticket). Reject anything
          // non-numeric so a tampered/malformed report file can't smuggle a JQL/label injection.
          if (!ISSUE_ID_PATTERN.test(issueId)) {
            continue;
          }
          flaws.push({
            issueId,
            severity: Number(flaw.severity),
            categoryName: category.categoryname,
            cweId: cwe.cweid != null ? String(cwe.cweid) : null,
            cweName: cwe.cwename ?? null,
            description: flaw.description ?? '',
            recommendation,
            module: flaw.module,
            sourceFile: flaw.sourcefile ?? null,
            sourceFilePath: flaw.sourcefilepath ?? null,
            line: flaw.line != null ? Number(flaw.line) : null,
            scope: flaw.scope ?? null,
            functionPrototype: flaw.functionprototype ?? null,
            remediationStatus: flaw.remediation_status,
          });
        }
      }
    }
  }
  return flaws;
}

export interface VeracodeFilterOptions {
  minSeverity: number;
  includeStatuses: string[];
}

export function filterFlaws(flaws: VeracodeFlaw[], options: VeracodeFilterOptions): VeracodeFlaw[] {
  const statusSet = new Set(options.includeStatuses.map(s => s.toLowerCase()));
  return flaws.filter(f => f.severity >= options.minSeverity && statusSet.has(f.remediationStatus.toLowerCase()));
}

const STOPWORDS = new Set(['of', 'a', 'an', 'the', 'or', 'and', 'used', 'in', 'to', 'for', 'on', 'using', 'via']);

// Prefers the CWE's own quoted short name (MITRE convention, e.g. "...('SQL Injection')"),
// falling back to the Veracode category name. Targets ~3 words, allows up to 5 for meaningfulness.
export function deriveShortLabel(categoryName: string, cweName: string | null): string {
  const quoted = cweName?.match(/'([^']+)'/)?.[1];
  const source = quoted ?? categoryName;
  const words = source.split(/\s+/).filter(Boolean);
  const filtered = words.filter(w => !STOPWORDS.has(w.toLowerCase()));
  const chosen = filtered.length > 0 ? filtered : words;
  return chosen.slice(0, 5).join(' ');
}

function fileRef(flaw: VeracodeFlaw): string {
  if (flaw.sourceFile) return flaw.sourceFile;
  const parts = flaw.module.split(/[\\/]/);
  return parts[parts.length - 1];
}

export function buildSummary(flaw: VeracodeFlaw): string {
  const ref = fileRef(flaw);
  const lineSuffix = flaw.line != null ? `:${flaw.line}` : '';
  const shortLabel = deriveShortLabel(flaw.categoryName, flaw.cweName);
  return `${flaw.issueId} - ${ref}${lineSuffix} - ${shortLabel}`;
}

function fullSourcePath(flaw: VeracodeFlaw): string | null {
  if (flaw.sourceFilePath && flaw.sourceFile) return `${flaw.sourceFilePath}${flaw.sourceFile}`;
  return flaw.sourceFile ?? null;
}

export function buildDescriptionWiki(flaw: VeracodeFlaw): string {
  const sections: string[] = [];

  sections.push(`h3. Severity\n${severityLabel(flaw.severity)} (${flaw.severity})`);

  if (flaw.cweId) {
    const link = `[CWE-${flaw.cweId}|https://cwe.mitre.org/data/definitions/${flaw.cweId}.html]`;
    sections.push(`h3. CWE\n${link}${flaw.cweName ? ` — ${flaw.cweName}` : ''}`);
  }

  const locationLines = [`Module: ${flaw.module}`];
  const path = fullSourcePath(flaw);
  if (path) locationLines.push(`File: ${path}${flaw.line != null ? `:${flaw.line}` : ''}`);
  if (flaw.functionPrototype) locationLines.push(`Function: ${flaw.functionPrototype}`);
  sections.push(`h3. Location\n${locationLines.join('\n')}`);

  sections.push(`h3. Description\n${flaw.description}`);

  if (flaw.recommendation) {
    sections.push(`h3. Recommendation\n${flaw.recommendation}`);
  }

  sections.push(`h3. Veracode Issue ID\n${flaw.issueId}`);

  return sections.join('\n\n');
}

export function buildLabels(flaw: VeracodeFlaw, templateLabels: string[] = []): string[] {
  const own = ['veracode', `veracode-issue-${flaw.issueId}`];
  if (flaw.cweId) own.push(`cwe-${flaw.cweId}`);
  return [...new Set([...own, ...templateLabels])];
}

const DEDUP_CHUNK_SIZE = 40; // keeps generated JQL well under Jira's practical query-length limits

export function chunkIssueIds(issueIds: string[], chunkSize = DEDUP_CHUNK_SIZE): string[][] {
  const chunks: string[][] = [];
  for (let i = 0; i < issueIds.length; i += chunkSize) {
    chunks.push(issueIds.slice(i, i + chunkSize));
  }
  return chunks;
}

export function buildDedupJql(projectKey: string, issueIds: string[]): string {
  const labels = issueIds.map(id => `veracode-issue-${id}`);
  return `project = ${projectKey} AND labels in (${labels.join(', ')})`;
}

export function extractDedupMap(issues: Array<{ key: string; labels: string[] }>): Map<string, string> {
  const map = new Map<string, string>();
  for (const issue of issues) {
    for (const label of issue.labels) {
      const match = label.match(/^veracode-issue-(\d+)$/);
      if (match) map.set(match[1], issue.key);
    }
  }
  return map;
}

// Lives here (rather than in sessionState.ts, where the other session-related types live) so that
// buildReviewRows() below can produce it directly without a type-only circular import between this
// file and sessionState.ts. sessionState.ts re-exports the type for callers that expect it there.
export interface VeracodeReviewRow {
  id: string; // '1'..'N' new candidates, 'A1'..'Am' already-ticketed
  issueId: string;
  severity: number;
  severityLabelText: string;
  cweId: string | null;
  summary: string;
  labels: string[];
  descriptionWiki: string;
  existingTicketKey: string | null;
  included: boolean; // whether this row will be (re)created if the batch runs
}
