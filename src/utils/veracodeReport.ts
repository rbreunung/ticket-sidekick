import { XMLParser } from 'fast-xml-parser';
import { markdownToJiraWiki } from './markdownToJiraWiki';
import {
  MAX_REPORT_BYTES as SHARED_MAX_REPORT_BYTES, sanitizeCellText, sanitizeStandaloneLine,
  clampSummary, fitWiki,
  type RowChange,
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
// Shared by buildDescriptionWiki()/buildGroupDescriptionWiki()/buildNewFindingsCommentWiki() — the
// Severity/CWE/Description/Recommendation blocks render identically in all three (only the heading
// level and which optional sections are included differ; the Location/Function layout around them
// does not, so that part stays inline per caller rather than being forced into a shared shape).
// The link text/URL are built entirely from the already-numeric-validated cweId, so no
// sanitization is needed there; cweName sits after it on the same line (mid-line, not standalone),
// so a bare sanitizeCellText() is the correct sanitizer for it.
function pushSeverityAndCwe(lines: string[], flaw: VeracodeFlaw, headingPrefix: string): void {
  lines.push(`${headingPrefix} Severity`);
  lines.push(`${severityLabel(flaw.severity)} (${flaw.severity})`);
  lines.push('');

  if (flaw.cweId) {
    lines.push(`${headingPrefix} CWE`);
    const link = `[CWE-${flaw.cweId}](https://cwe.mitre.org/data/definitions/${flaw.cweId}.html)`;
    lines.push(`${link}${flaw.cweName ? ` — ${sanitizeCellText(flaw.cweName)}` : ''}`);
    lines.push('');
  }
}

// `cap` shortens the text for a folded ticket that is over its size budget (R10); the cut is made
// on the raw value, before sanitizing, so the sanitizers still see (and neutralize) every character.
function capText(text: string, cap: number): string {
  return text.length > cap ? `${text.slice(0, cap).trimEnd()}…` : text;
}

function pushDescription(lines: string[], flaw: VeracodeFlaw, headingPrefix: string, cap = Infinity): void {
  lines.push(`${headingPrefix} Description`);
  lines.push(sanitizeStandaloneLine(capText(flaw.description, cap)));
  lines.push('');
}

function pushRecommendation(lines: string[], flaw: VeracodeFlaw, headingPrefix: string, cap = Infinity): void {
  if (!flaw.recommendation) return;
  lines.push(`${headingPrefix} Recommendation`);
  lines.push(sanitizeStandaloneLine(capText(flaw.recommendation, cap)));
  lines.push('');
}

export function buildDescriptionWiki(flaw: VeracodeFlaw): string {
  const lines: string[] = [];

  pushSeverityAndCwe(lines, flaw, '###');

  lines.push('### Location');
  lines.push(`Module: ${sanitizeCellText(flaw.module)}`);
  const path = fullSourcePath(flaw);
  if (path) lines.push(`File: ${path}${flaw.line != null ? `:${flaw.line}` : ''}`);
  if (flaw.functionPrototype) lines.push(`Function: ${sanitizeCellText(flaw.functionPrototype)}`);
  lines.push('');

  pushDescription(lines, flaw, '###');
  pushRecommendation(lines, flaw, '###');

  lines.push('### Veracode Issue ID');
  lines.push(flaw.issueId);

  return markdownToJiraWiki(lines.join('\n'));
}

export function buildLabels(flaw: VeracodeFlaw, templateLabels: string[] = []): string[] {
  const own = ['veracode', `veracode-issue-${flaw.issueId}`];
  if (flaw.cweId) own.push(`cwe-${flaw.cweId}`);
  return [...new Set([...own, ...templateLabels])];
}

// --- Folding (grouping related flaws) -----------------------------------------------------------
//
// R2 (finding folding plan): flaws fold into one review row / one ticket when they share a source
// file AND a CWE (any line), or share a source file AND a line (any CWE). The two rules link flaws
// transitively, so one flaw can never appear in two groups. A flaw with no source file never folds
// with anything, and a flaw with no CWE never folds by CWE (it still folds by line).

// The `::` separator between the path and file segments is required: bare concatenation (the
// pattern fullSourcePath() uses for *display*, where a collision is only cosmetic) lets two flaws
// in genuinely different locations produce the same key — e.g. path `src/foo/` + file `bar.js`
// versus path `src/foo/bar.` + file `js` both concatenate to `src/foo/bar.js`, but with `::`
// inserted between path and file they key as `src/foo/::bar.js` and `src/foo/bar.::js`
// respectively, which differ.
function fileKey(flaw: VeracodeFlaw): string | null {
  if (flaw.sourceFile == null) return null;
  return `${flaw.sourceFilePath ?? ''}::${flaw.sourceFile}`;
}

/** The keys a flaw can be linked through: same file + same line, and same file + same CWE. */
function linkKeys(flaw: VeracodeFlaw): string[] {
  const file = fileKey(flaw);
  if (file === null) return [];
  const keys: string[] = [];
  if (flaw.line != null) keys.push(`line:${file}:${flaw.line}`);
  if (flaw.cweId != null) keys.push(`cwe:${file}|${flaw.cweId}`);
  return keys;
}

/**
 * Groups flaws that share a source file and either a CWE or a line number (R2). Groups are the
 * transitive closure of the two rules. A flaw with no source file is never folded with another flaw
 * — including another flaw that also lacks one — so it always comes back as its own singleton
 * group. Group order follows first-occurrence order of each group's first member in the input;
 * members within a group keep their relative input order.
 */
export function groupFlawsByLocation(flaws: VeracodeFlaw[]): VeracodeFlaw[][] {
  const parent = flaws.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const firstWithKey = new Map<string, number>();
  flaws.forEach((flaw, i) => {
    for (const key of linkKeys(flaw)) {
      const first = firstWithKey.get(key);
      if (first === undefined) firstWithKey.set(key, i);
      else parent[find(i)] = find(first);
    }
  });

  const groups: VeracodeFlaw[][] = [];
  const rootToGroup = new Map<number, VeracodeFlaw[]>();
  flaws.forEach((flaw, i) => {
    const root = find(i);
    const existing = rootToGroup.get(root);
    if (existing) {
      existing.push(flaw);
    } else {
      const group = [flaw];
      rootToGroup.set(root, group);
      groups.push(group);
    }
  });
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

// --- Folded ticket content (finding folding plan: R8-R10, R14, R15) ------------------------------

/**
 * A folded group's title parts. `head` is the first member's file (the only part that may be
 * trimmed to fit Jira's summary limit); `tail` carries what must always survive: how many other
 * files, the finding count and the CWE labels. A fold that spans several CWEs or files says so in
 * the title instead of hiding it behind the first member's label.
 */
function foldedTitleParts(group: VeracodeFlaw[]): { head: string; tail: string } {
  const first = group[0];
  const files = new Set(group.map(f => fileKey(f) ?? `module:${f.module}`));
  const labels = [...new Set(group.map(f => deriveShortLabel(f.categoryName, f.cweName)))];
  const otherFiles = files.size - 1;
  const fileTail = otherFiles > 0 ? ` +${otherFiles} file${otherFiles === 1 ? '' : 's'}` : '';
  const shown = labels.slice(0, 3).join(', ');
  const more = labels.length > 3 ? `, +${labels.length - 3} more CWEs` : '';
  const what = labels.length === 1
    ? `${labels[0]} (${group.length} findings)`
    : `${group.length} findings: ${shown}${more}`;
  return { head: fileRef(first), tail: `${fileTail} - ${what}` };
}

/**
 * Group-aware summary builder. A singleton group renders identically to `buildSummary()`. A folded
 * group is count-based (R9): `<file> - <CWE label> (<n> findings)`, `<file> - <n> findings: <labels>`
 * when CWEs are mixed, and `<file> +<m> files - …` when it spans files — never an id list, which
 * cannot fit in a large fold. The issue ids stay in the description table and the labels.
 */
export function buildGroupSummary(group: VeracodeFlaw[]): string {
  if (group.length === 1) return buildSummary(group[0]);
  const { head, tail } = foldedTitleParts(group);
  return clampSummary(head, tail);
}

// Per-finding description/recommendation caps by detail level (R10); the last level drops the
// per-finding sections altogether and leaves the (always complete) overview table.
const FOLD_TEXT_CAPS = [Infinity, 400, 120];
const FOLD_LEVELS = FOLD_TEXT_CAPS.length + 1;

function severityText(flaw: VeracodeFlaw): string {
  return `${severityLabel(flaw.severity)} (${flaw.severity})`;
}

function locationText(flaw: VeracodeFlaw): string {
  const path = fullSourcePath(flaw);
  return path ? `${path}${flaw.line != null ? `:${flaw.line}` : ''}` : sanitizeCellText(fileRef(flaw));
}

function pushFoldedTable(lines: string[], group: VeracodeFlaw[]): void {
  lines.push('| Issue ID | Severity | CWE | Location | Function |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const flaw of group) {
    const cwe = flaw.cweId ? `CWE-${flaw.cweId}` : 'n/a';
    const fn = flaw.functionPrototype ? sanitizeCellText(flaw.functionPrototype) : 'n/a';
    lines.push(`| ${flaw.issueId} | ${severityText(flaw)} | ${cwe} | ${locationText(flaw)} | ${fn} |`);
  }
  lines.push('');
}

function pushFoldedSection(lines: string[], flaw: VeracodeFlaw, cap: number): void {
  lines.push(`### Issue ${flaw.issueId}`);
  lines.push('');
  lines.push('#### Location');
  lines.push(`Module: ${sanitizeCellText(flaw.module)}`);
  const path = fullSourcePath(flaw);
  if (path) lines.push(`File: ${path}${flaw.line != null ? `:${flaw.line}` : ''}`);
  if (flaw.functionPrototype) lines.push(`Function: ${sanitizeCellText(flaw.functionPrototype)}`);
  lines.push('');
  pushSeverityAndCwe(lines, flaw, '####');
  pushDescription(lines, flaw, '####', cap);
  pushRecommendation(lines, flaw, '####', cap);
}

/**
 * Banner, overview table (one row per finding, always complete), then one section per finding with
 * its own location — nothing is hoisted, because a fold can span files (R8). `level` steps the
 * per-finding text down (R10) until the output fits; `droppedIds` names findings a rewritten ticket
 * recorded that its new description no longer covers (R15).
 */
function buildFoldedMarkdown(group: VeracodeFlaw[], banner: string, level: number, droppedIds: string[]): string {
  const lines: string[] = [banner, ''];
  if (level > 0) {
    lines.push("Per-finding text was shortened to fit Jira's size limit; the table lists every finding.");
    lines.push('');
  }
  pushFoldedTable(lines, group);
  if (level < FOLD_LEVELS - 1) {
    const cap = FOLD_TEXT_CAPS[level];
    for (const flaw of group) pushFoldedSection(lines, flaw, cap);
  }
  if (droppedIds.length > 0) {
    lines.push('### No longer in the description');
    lines.push(`The ticket recorded these issue ids, which the latest report no longer covers here: ${droppedIds.join(', ')}.`);
    lines.push('');
  }
  return lines.join('\n');
}

function buildFoldedWiki(group: VeracodeFlaw[], banner: string, droppedIds: string[] = []): string {
  return fitWiki(level => markdownToJiraWiki(buildFoldedMarkdown(group, banner, level, droppedIds)), FOLD_LEVELS).wiki;
}

/** A one-flaw ticket: hoisted Location, then the flaw's own sections — the layout before folding existed. */
function buildSingleFlawDescriptionWiki(flaw: VeracodeFlaw): string {
  const lines: string[] = [];

  lines.push('### Location');
  lines.push(`Module: ${sanitizeCellText(flaw.module)}`);
  const path = fullSourcePath(flaw);
  if (path) lines.push(`File: ${path}${flaw.line != null ? `:${flaw.line}` : ''}`);
  lines.push('');

  lines.push(`### Issue ${flaw.issueId}`);
  lines.push('');

  pushSeverityAndCwe(lines, flaw, '####');

  if (flaw.functionPrototype) {
    lines.push(`Function: ${sanitizeCellText(flaw.functionPrototype)}`);
    lines.push('');
  }

  pushDescription(lines, flaw, '####');
  pushRecommendation(lines, flaw, '####');

  return markdownToJiraWiki(lines.join('\n'));
}

/**
 * Group-aware description builder. A one-flaw group renders as it did before folding. A folded
 * group opens with a banner and an overview table so the fold is unmissable (R8), then one section
 * per finding with its own location, and shortens per-finding text when it would exceed the size
 * budget (R10). Every untrusted field goes through the same `sanitizeCellText()` /
 * `sanitizeStandaloneLine()` sanitizers as the single-flaw path, and the Markdown is converted once
 * via `markdownToJiraWiki()` at the end.
 */
export function buildGroupDescriptionWiki(group: VeracodeFlaw[]): string {
  if (group.length === 1) return buildSingleFlawDescriptionWiki(group[0]);
  return buildFoldedWiki(group, `This ticket folds ${group.length} Veracode findings.`);
}

/**
 * The comment an `add … to <KEY>` posts (R14, R15): the added findings in the same banner, table and
 * sections form as a folded description, each with its own file and line. `droppedIds` are issue
 * ids the ticket recorded that a rewrite no longer covers.
 */
export function buildFoldedCommentWiki(group: VeracodeFlaw[], droppedIds: string[] = []): string {
  const banner = group.length === 1
    ? 'This Veracode finding was added to this ticket.'
    : `These ${group.length} Veracode findings were added to this ticket.`;
  return buildFoldedWiki(group, banner, droppedIds);
}

/**
 * Builds the `update` action's comment body for the given new flaws (already filtered by the caller
 * to the flaws newly added this run): one `### Issue <id>` block per flaw (severity, CWE,
 * description; no `### Location` — the ticket the comment is posted to already carries it). Every
 * untrusted field is sanitized via `sanitizeCellText()`/`sanitizeStandaloneLine()`, and the whole
 * body is authored as Markdown and converted via `markdownToJiraWiki()` exactly once at the end.
 * `addComment()` sends the body to Jira verbatim, so this sanitization is what prevents Jira
 * wiki-markup injection from crafted report fields.
 */
export function buildNewFindingsCommentWiki(newFlaws: VeracodeFlaw[]): string {
  const lines: string[] = [];
  lines.push(`New finding(s) detected on this line since the ticket was created:`);
  lines.push('');

  for (const flaw of newFlaws) {
    lines.push(`### Issue ${flaw.issueId}`);
    lines.push('');

    pushSeverityAndCwe(lines, flaw, '####');
    pushDescription(lines, flaw, '####');
  }

  return markdownToJiraWiki(lines.join('\n'));
}

/**
 * U3/R2: the Veracode change describer for buildReviewRows — a folded group's new findings are the
 * member flaw ids whose `veracode-issue-<id>` label none of its tickets carry (`knownLabels` is the
 * union across all of them). Veracode has no baseline and no rating rise; null when nothing is new.
 */
export function describeVeracodeChange(group: VeracodeFlaw[], knownLabels: string[]): RowChange | null {
  const known = new Set(knownLabels);
  const newIds = [...new Set(group.map(f => f.issueId))].filter(id => !known.has(`veracode-issue-${id}`));
  return newIds.length > 0 ? { kind: 'findings', newIds } : null;
}

/** U5: the members of a folded group whose issue id is in `ids`, in group order. */
export function flawsWithIds(group: VeracodeFlaw[], ids: string[]): VeracodeFlaw[] {
  const wanted = new Set(ids);
  return group.filter(f => wanted.has(f.issueId));
}

/**
 * U5/KTD10: a follow-up ticket's summary — the group summary over only the new flaws (`subset`,
 * see {@link flawsWithIds}) plus ` (follow-up to <KEY>)`, so the two tickets stay distinguishable.
 */
export function buildFollowUpSummary(subset: VeracodeFlaw[], originalKey: string): string {
  const suffix = ` (follow-up to ${originalKey})`;
  if (subset.length === 1) return `${buildSummary(subset[0])}${suffix}`;
  const { head, tail } = foldedTitleParts(subset);
  return clampSummary(head, tail + suffix);
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
  // U4/R6-R7: the folded group itself, kept so the full ticket description — expensive to build
  // (markdownToJiraWiki() across every member flaw's own description/recommendation/CWE) — is
  // built lazily via buildGroupDescriptionWiki() only for a row the user actually confirms into
  // creation (veracodeHandler.ts's buildTicketFields), rather than eagerly for every "new"
  // candidate the report matched, most of which a paged review screen never even shows.
  sourceGroup: VeracodeFlaw[];
  existingTicketKey: string | null;
  included: boolean; // whether this row will be (re)created if the batch runs
}
