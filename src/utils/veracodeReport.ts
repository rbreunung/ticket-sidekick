import { XMLParser } from 'fast-xml-parser';
import { markdownToJiraWiki } from './markdownToJiraWiki';
import {
  MAX_REPORT_BYTES as SHARED_MAX_REPORT_BYTES, sanitizeCellText, sanitizeStandaloneLine,
} from './reportImport';

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

// Exported (rather than a local/duplicated constant) so extension.ts's file-size pre-check and any
// other caller share this single source of truth instead of independently hardcoded copies.
// Traces back to reportImport.ts's shared MAX_REPORT_BYTES (KTD4) — value unchanged (20 MB).
export const MAX_REPORT_BYTES = SHARED_MAX_REPORT_BYTES;

// Defense-in-depth: fast-xml-parser does not resolve external entities, but we
// reject DOCTYPE/ENTITY declarations outright so a malicious file is never even parsed.
// `maxBytes` defaults to the shared constant so every existing single-argument call (including the
// pure unit tests) keeps working unchanged; a configured caller (veracodeHandler.ts, extension.ts)
// passes its own resolved limit explicitly.
export function assertSafeVeracodeXml(raw: string, maxBytes: number = MAX_REPORT_BYTES): void {
  if (Buffer.byteLength(raw, 'utf8') > maxBytes) {
    throw new Error(`Veracode report exceeds the ${maxBytes / (1024 * 1024)} MB size limit.`);
  }
  if (/<!DOCTYPE/i.test(raw) || /<!ENTITY/i.test(raw)) {
    throw new Error('Veracode report contains a DOCTYPE/ENTITY declaration and was rejected for security reasons.');
  }
}

// Elements that may repeat but fast-xml-parser only arrays when count > 1 — force arrays always.
const ARRAY_TAGS = new Set(['severity', 'category', 'cwe', 'flaw', 'para']);

// issueid must be purely numeric — see the JQL-injection defense note in parseVeracodeReport below.
const ISSUE_ID_PATTERN = /^\d+$/;

// cweid must be purely numeric too. This is a point-fix for a URL-interpolation context
// specifically: cweId is interpolated directly into a generated CWE-database link
// (`https://cwe.mitre.org/data/definitions/${flaw.cweId}.html]` in buildDescriptionWiki below), and
// span-text sanitization (sanitizeCellText()/sanitizeStandaloneLine() in reportImport.ts) does not
// make a value safe inside a URL — that's a different context with different rules (e.g. a value
// containing `]` followed by attacker-controlled link/pipe text could break out of the `[text|url]`
// Jira link syntax even though none of the Markdown-structural characters those sanitizers strip
// are involved). A future field interpolated into a generated link needs its own validation, not a
// reuse of the span-text sanitizer.
const CWE_ID_PATTERN = /^\d+$/;

function toArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function extractRecommendation(recommendations: unknown): string | null {
  const recs = recommendations as { para?: Array<{ text?: string }> } | undefined;
  const paras = toArray(recs?.para).map(p => p.text).filter((t): t is string => Boolean(t));
  return paras.length > 0 ? paras.join('\n\n') : null;
}

export function parseVeracodeReport(xml: string, maxBytes: number = MAX_REPORT_BYTES): VeracodeFlaw[] {
  assertSafeVeracodeXml(xml, maxBytes);

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    isArray: (tagName: string) => ARRAY_TAGS.has(tagName),
    // fast-xml-parser only decodes the 5 predefined XML entities (&amp; &lt; &gt; &apos; &quot;) by
    // default — numeric character references (e.g. &#x28; / &#x29;) are left as literal text unless
    // htmlEntities is enabled. Veracode reports encode literal parentheses in categoryname/type/
    // description this way (e.g. "Cross-Site Scripting &#x28;XSS&#x29;"), so without this flag those
    // strings would render un-decoded in ticket summaries and descriptions.
    htmlEntities: true,
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
          const rawCweId = cwe.cweid != null ? String(cwe.cweid) : null;
          // Drop (rather than pass through) a malformed cweId instead of letting it survive into
          // the URL it's later interpolated into — see the CWE_ID_PATTERN comment above.
          const cweId = rawCweId != null && CWE_ID_PATTERN.test(rawCweId) ? rawCweId : null;
          flaws.push({
            issueId,
            severity: Number(flaw.severity),
            categoryName: category.categoryname,
            cweId,
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

// Same branching as before (decide on the *original* values so a value that sanitizes down to an
// empty string — e.g. one consisting only of stripped characters — doesn't silently flip which
// branch runs), just with each piece sanitized before it's combined into the displayed path.
function fullSourcePath(flaw: VeracodeFlaw): string | null {
  if (flaw.sourceFilePath && flaw.sourceFile) {
    return `${sanitizeCellText(flaw.sourceFilePath)}${sanitizeCellText(flaw.sourceFile)}`;
  }
  return flaw.sourceFile != null ? sanitizeCellText(flaw.sourceFile) : null;
}

// sanitizeCellText()/sanitizeStandaloneLine() (both untrusted-input sanitizers for values that get
// interpolated into the Markdown built here) live in reportImport.ts as shared primitives — see the
// doc comments there for exactly what each one neutralizes and why.

// Authored as Markdown and converted once at the end via markdownToJiraWiki() — mirrors
// waltzReport.ts's buildDescriptionWiki() pattern exactly. Every untrusted (externally-sourced,
// unvalidated) free-text field is wrapped in sanitizeCellText() (mid-line, after a trusted label
// like "Module: ") or sanitizeStandaloneLine() (the value is the *entire* line, nothing else on it —
// exposed to every line-start-anchored rule the converter has). issueId/cweId/severity are left
// unsanitized: issueId and cweId are already validated purely-numeric at parse time (ISSUE_ID_PATTERN
// / CWE_ID_PATTERN) and severity is a locally-computed number, so none of the three can carry a
// markdown-trigger character to begin with.
export function buildDescriptionWiki(flaw: VeracodeFlaw): string {
  const lines: string[] = [];

  lines.push('### Severity');
  lines.push(`${severityLabel(flaw.severity)} (${flaw.severity})`);
  lines.push('');

  if (flaw.cweId) {
    lines.push('### CWE');
    // The link text/URL are built entirely from the already-numeric-validated cweId, so no
    // sanitization is needed there; cweName sits after it on the same line (mid-line, not
    // standalone), so a bare sanitizeCellText() is the correct sanitizer for it.
    const link = `[CWE-${flaw.cweId}](https://cwe.mitre.org/data/definitions/${flaw.cweId}.html)`;
    lines.push(`${link}${flaw.cweName ? ` — ${sanitizeCellText(flaw.cweName)}` : ''}`);
    lines.push('');
  }

  lines.push('### Location');
  lines.push(`Module: ${sanitizeCellText(flaw.module)}`);
  const path = fullSourcePath(flaw);
  if (path) lines.push(`File: ${path}${flaw.line != null ? `:${flaw.line}` : ''}`);
  if (flaw.functionPrototype) lines.push(`Function: ${sanitizeCellText(flaw.functionPrototype)}`);
  lines.push('');

  lines.push('### Description');
  lines.push(sanitizeStandaloneLine(flaw.description));
  lines.push('');

  if (flaw.recommendation) {
    lines.push('### Recommendation');
    lines.push(sanitizeStandaloneLine(flaw.recommendation));
    lines.push('');
  }

  lines.push('### Veracode Issue ID');
  lines.push(flaw.issueId);

  return markdownToJiraWiki(lines.join('\n'));
}

export function buildLabels(flaw: VeracodeFlaw, templateLabels: string[] = []): string[] {
  const own = ['veracode', `veracode-issue-${flaw.issueId}`];
  if (flaw.cweId) own.push(`cwe-${flaw.cweId}`);
  return [...new Set([...own, ...templateLabels])];
}

// --- Folding (grouping same-line flaws) ---------------------------------------------------------
//
// R9/R12: flaws sharing a source file + line number fold into one review row / one ticket,
// regardless of CWE or category, UNLESS either sourceFile or line is missing — a flaw with no
// location never folds with anything, even another flaw that also lacks a location (each such flaw
// stays its own singleton group, never grouped with another missing-location flaw either).

// The `::` separator between the path and file segments is required: bare concatenation (the
// pattern fullSourcePath() uses for *display*, where a collision is only cosmetic) lets two flaws
// in genuinely different locations produce the same key — e.g. path `src/foo/` + file `bar.js`
// versus path `src/foo/bar.` + file `js` both concatenate to `src/foo/bar.js`, but with `::`
// inserted between path and file they key as `src/foo/::bar.js:10` and `src/foo/bar.::js:10`
// respectively, which differ.
function groupKey(flaw: VeracodeFlaw): string | null {
  if (flaw.sourceFile == null || flaw.line == null) return null;
  return `${flaw.sourceFilePath ?? ''}::${flaw.sourceFile}:${flaw.line}`;
}

/**
 * Groups flaws that share a source file + line number (R9). A flaw missing either field is never
 * folded with another flaw (R12) — including another flaw that also lacks a location — so it
 * always comes back as its own singleton group. Group order follows first-occurrence order of each
 * group's first member in the input; members within a group keep their relative input order.
 */
export function groupFlawsByLocation(flaws: VeracodeFlaw[]): VeracodeFlaw[][] {
  const groups: VeracodeFlaw[][] = [];
  const keyToGroup = new Map<string, VeracodeFlaw[]>();
  for (const flaw of flaws) {
    const key = groupKey(flaw);
    if (key === null) {
      groups.push([flaw]);
      continue;
    }
    const existing = keyToGroup.get(key);
    if (existing) {
      existing.push(flaw);
    } else {
      const group = [flaw];
      keyToGroup.set(key, group);
      groups.push(group);
    }
  }
  return groups;
}

/**
 * Group-aware label builder (R10): unions every member flaw's own `buildLabels()` output (so one
 * `veracode-issue-<id>` per folded flaw, one `cwe-<id>` per distinct CWE among them — a repeated
 * CWE across members contributes only one label since both the per-flaw call and the outer `Set`
 * dedupe), then merges in template labels and dedupes again.
 */
export function buildGroupLabels(group: VeracodeFlaw[], templateLabels: string[] = []): string[] {
  const own = new Set<string>();
  for (const flaw of group) {
    for (const label of buildLabels(flaw)) own.add(label);
  }
  return [...new Set([...own, ...templateLabels])];
}

/**
 * Group-aware summary builder. A singleton group renders identically to `buildSummary()`. A
 * multi-flaw group lists every folded issue id, keeps the (shared) file:line location, uses the
 * first member's short label, and notes how many additional flaws are folded in.
 */
export function buildGroupSummary(group: VeracodeFlaw[]): string {
  const first = group[0];
  if (group.length === 1) return buildSummary(first);
  const ref = fileRef(first);
  const lineSuffix = first.line != null ? `:${first.line}` : '';
  const shortLabel = deriveShortLabel(first.categoryName, first.cweName);
  const ids = group.map(f => f.issueId).join(', ');
  return `${ids} - ${ref}${lineSuffix} - ${shortLabel} (+${group.length - 1} more)`;
}

/**
 * Group-aware description builder (R10): hoists the shared file+line `### Location` once (all
 * members share it by construction — see `groupKey()`), then renders each folded flaw's own
 * severity/CWE/description/recommendation under its own `### Issue <id>` heading. Every untrusted
 * field is routed through the same `sanitizeCellText()`/`sanitizeStandaloneLine()` sanitizers
 * `buildDescriptionWiki()` uses — no raw string concatenation bypasses either sanitizer layer — and
 * the combined Markdown is converted once via `markdownToJiraWiki()` at the end, same as the
 * single-flaw path.
 */
export function buildGroupDescriptionWiki(group: VeracodeFlaw[]): string {
  const first = group[0];
  const lines: string[] = [];

  lines.push('### Location');
  lines.push(`Module: ${sanitizeCellText(first.module)}`);
  const path = fullSourcePath(first);
  if (path) lines.push(`File: ${path}${first.line != null ? `:${first.line}` : ''}`);
  lines.push('');

  for (const flaw of group) {
    lines.push(`### Issue ${flaw.issueId}`);
    lines.push('');

    lines.push('#### Severity');
    lines.push(`${severityLabel(flaw.severity)} (${flaw.severity})`);
    lines.push('');

    if (flaw.cweId) {
      lines.push('#### CWE');
      const link = `[CWE-${flaw.cweId}](https://cwe.mitre.org/data/definitions/${flaw.cweId}.html)`;
      lines.push(`${link}${flaw.cweName ? ` — ${sanitizeCellText(flaw.cweName)}` : ''}`);
      lines.push('');
    }

    if (flaw.functionPrototype) {
      lines.push(`Function: ${sanitizeCellText(flaw.functionPrototype)}`);
      lines.push('');
    }

    lines.push('#### Description');
    lines.push(sanitizeStandaloneLine(flaw.description));
    lines.push('');

    if (flaw.recommendation) {
      lines.push('#### Recommendation');
      lines.push(sanitizeStandaloneLine(flaw.recommendation));
      lines.push('');
    }
  }

  return markdownToJiraWiki(lines.join('\n'));
}

// Lives here (rather than in sessionState.ts, where the other session-related types live) so that
// reportImportHandler.ts's shared buildReviewRows() can produce it directly without a type-only
// circular import between this file and sessionState.ts. sessionState.ts re-exports the type for
// callers that expect it there.
export interface VeracodeReviewRow {
  id: string; // '1'..'N' new candidates, 'A1'..'Am' already-ticketed
  issueIds: string[]; // one or more folded Veracode issue ids (R9/R10) — a non-folded row has length 1
  severity: number;
  severityLabelText: string;
  cweId: string | null;
  summary: string;
  labels: string[];
  descriptionWiki: string;
  existingTicketKey: string | null;
  included: boolean; // whether this row will be (re)created if the batch runs
}
