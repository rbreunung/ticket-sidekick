import { createHash } from 'crypto';
import { readSheet, parseSheetData, SheetNotFoundError, type Schema } from 'read-excel-file/node';
import { markdownToJiraWiki } from './markdownToJiraWiki';
import {
  MAX_REPORT_BYTES as SHARED_MAX_REPORT_BYTES, BATCH_LIMIT as SHARED_BATCH_LIMIT,
  chunkStrings, buildDedupJql as buildDedupJqlShared, extractDedupMap as extractDedupMapShared,
  buildReviewRows as buildReviewRowsShared, type JqlIssueLike,
} from './reportImport';

export interface WaltzVulnerability {
  cveId: string;
  cveSummary: string | null;
  overallSeverity: string | null;
  cvssV3Score: number | null;
  fixedVersion: string | null;
}

export interface WaltzComponent {
  nameVersion: string;
  maxVulnRating: string;
  remediationAction: string | null;
  instancePaths: string[];
  vulnerabilities: WaltzVulnerability[];
}

// Exported (rather than a local/duplicated constant) so waltzHandler.ts and extension.ts's file-size
// pre-check share this single source of truth instead of three independently hardcoded copies.
// Traces back to reportImport.ts's shared MAX_REPORT_BYTES (KTD4) — value unchanged (20 MB).
export const MAX_REPORT_BYTES = SHARED_MAX_REPORT_BYTES;
const REQUIRED_SHEET = 'ComponentRemediations';

export function assertSafeWaltzReportSize(buffer: Buffer): void {
  if (buffer.length > MAX_REPORT_BYTES) {
    throw new Error(`OSS report exceeds the ${MAX_REPORT_BYTES / (1024 * 1024)} MB size limit.`);
  }
}

interface ComponentRemediationsRow {
  nameVersion: string;
  maxVulnRating: string;
  remediationAction: string | null;
}

interface VersionInstanceRow {
  nameVersion: string;
  instancePath: string | null;
}

interface VulnerabilityRow {
  nameVersion: string;
  cveId: string;
  cveSummary: string | null;
  overallSeverity: string | null;
  cvssV3Score: number | null;
  fixedVersion: string | null;
}

const componentRemediationsSchema: Schema<ComponentRemediationsRow> = {
  nameVersion: { column: 'Component name and version', type: String, required: true },
  maxVulnRating: { column: 'Max Vuln Rating', type: String, required: true },
  remediationAction: { column: 'Remediation Action', type: String, required: false },
};

const versionInstancesSchema: Schema<VersionInstanceRow> = {
  nameVersion: { column: 'Component name and version', type: String, required: true },
  instancePath: { column: 'Component Instance Path', type: String, required: false },
};

const vulnerabilitiesSchema: Schema<VulnerabilityRow> = {
  nameVersion: { column: 'Component name and version', type: String, required: true },
  cveId: { column: 'CVE Id', type: String, required: true },
  cveSummary: { column: 'CVE Summary', type: String, required: false },
  overallSeverity: { column: 'Overall Severity', type: String, required: false },
  cvssV3Score: { column: 'CVSS_V3 severity base score', type: Number, required: false },
  fixedVersion: { column: 'Fixed Version', type: String, required: false },
};

// Reads one sheet by name and parses it against a schema — read-excel-file's readSheet() can't
// combine `sheet` + `schema` in a single call (verified against the installed .d.ts in Task 1),
// so this is a deliberate two-step helper, not an oversight. `schema` is typed as the library's own
// `Schema<T>` (not a loosely-typed Record) so a schema/interface mismatch is a compile error instead
// of a silently-accepted `as never` cast.
async function readNamedSheet<T extends object>(
  buffer: Buffer,
  sheetName: string,
  schema: Schema<T>,
): Promise<T[]> {
  const sheetData = await readSheet(buffer, sheetName);
  const { objects, errors } = parseSheetData<T>(sheetData, schema);
  if (errors) {
    throw new Error(
      `OSS report sheet "${sheetName}" has invalid rows: ` +
        errors.map(e => `row ${e.row} column "${e.column}": ${e.error}`).join('; '),
    );
  }
  return objects ?? [];
}

// Optional sheets degrade to an empty array instead of failing the whole import.
async function readOptionalNamedSheet<T extends object>(
  buffer: Buffer,
  sheetName: string,
  schema: Schema<T>,
): Promise<T[]> {
  try {
    return await readNamedSheet<T>(buffer, sheetName, schema);
  } catch (err) {
    if (err instanceof SheetNotFoundError) return [];
    throw err;
  }
}

const PARSE_TIMEOUT_MS = 15_000; // hard ceiling so a pathological file (e.g. a decompression-bomb-style
// worksheet entry — see CLAUDE.md's "Waltz OSS report import" section) fails fast instead of exhausting
// memory or hanging the extension host. Bounds wall-clock time, not memory directly, but a
// hung/thrashing parse is exactly what this catches.

export async function parseWaltzReport(buffer: Buffer): Promise<WaltzComponent[]> {
  let timeoutHandle: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      parseWaltzReportInner(buffer),
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new Error(`OSS report parsing exceeded ${PARSE_TIMEOUT_MS / 1000}s — the file may be malformed or unusually large.`)),
          PARSE_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeoutHandle!);
  }
}

async function parseWaltzReportInner(buffer: Buffer): Promise<WaltzComponent[]> {
  assertSafeWaltzReportSize(buffer);

  let remediations: ComponentRemediationsRow[];
  try {
    remediations = await readNamedSheet(buffer, REQUIRED_SHEET, componentRemediationsSchema);
  } catch (err) {
    if (err instanceof SheetNotFoundError) {
      // read-excel-file's SheetNotFoundError type only declares `sheet` (singular) publicly —
      // `sheets` is set at runtime but not part of the .d.ts surface, so reference `err.message`
      // (which already embeds the available sheet list) rather than `err.sheets`.
      throw new Error(`OSS report is missing the required "${REQUIRED_SHEET}" sheet. (${err.message})`);
    }
    throw new Error(`Could not read OSS report: ${err instanceof Error ? err.message : String(err)}`);
  }

  const instances = await readOptionalNamedSheet<VersionInstanceRow>(buffer, 'VersionInstances', versionInstancesSchema);
  const vulnerabilities = await readOptionalNamedSheet<VulnerabilityRow>(buffer, 'Vulnerabilities', vulnerabilitiesSchema);

  // A malformed or hand-edited report can list the same component twice in ComponentRemediations
  // (copy-paste, a re-scanned component re-appended instead of updated in place). Without
  // deduplication here, each duplicate row would produce its own WaltzReviewRow sharing the same
  // dedup label, both defaulting to included — creating two Jira tickets for one component in a
  // single batch. Keep the first occurrence; VersionInstances/Vulnerabilities are still joined by
  // nameVersion below, so no per-row detail is lost by collapsing the duplicate remediation rows.
  const uniqueRemediations = new Map<string, ComponentRemediationsRow>();
  for (const r of remediations) {
    if (!uniqueRemediations.has(r.nameVersion)) uniqueRemediations.set(r.nameVersion, r);
  }

  return [...uniqueRemediations.values()].map(r => ({
    nameVersion: r.nameVersion,
    maxVulnRating: r.maxVulnRating,
    remediationAction: r.remediationAction,
    instancePaths: instances
      .filter(i => i.nameVersion === r.nameVersion && i.instancePath)
      .map(i => i.instancePath as string),
    vulnerabilities: vulnerabilities
      .filter(v => v.nameVersion === r.nameVersion)
      .map(v => ({
        cveId: v.cveId,
        cveSummary: v.cveSummary,
        overallSeverity: v.overallSeverity,
        cvssV3Score: v.cvssV3Score,
        fixedVersion: v.fixedVersion,
      })),
  }));
}

export interface WaltzFilterOptions {
  minVulnRating: string; // 'Low' | 'Medium' | 'High' | 'Critical'
  includeRemediationActions: string[]; // '' represents a blank cell
}

const VULN_RATING_ORDER = ['None', 'Low', 'Medium', 'High', 'Critical'];

function vulnRatingRank(rating: string): number {
  const idx = VULN_RATING_ORDER.findIndex(r => r.toLowerCase() === rating.toLowerCase());
  return idx === -1 ? 0 : idx;
}

export function filterComponents(components: WaltzComponent[], options: WaltzFilterOptions): WaltzComponent[] {
  const floor = vulnRatingRank(options.minVulnRating);
  const allowedActions = new Set(options.includeRemediationActions.map(a => a.trim()));
  return components.filter(c => {
    if (vulnRatingRank(c.maxVulnRating) < floor) return false;
    const action = (c.remediationAction ?? '').trim();
    return allowedActions.has(action);
  });
}

const MAX_LABEL_LENGTH = 250; // safety margin under Jira's actual label length limit
const MAX_CVES_SHOWN = 10;
const MAX_ARTIFACTS_SHOWN = 25; // mirrors MAX_CVES_SHOWN's "+N more" pattern for the artifact-paths list
const LABEL_HASH_LENGTH = 6; // hex chars appended to disambiguate labels that sanitize to the same text

// sanitizeComponentLabel()'s character-collapsing is lossy (e.g. Maven "my_lib" and "my-lib" both
// become "my-lib" once the underscore is replaced by a hyphen), so two distinct components can land
// on the identical readable label — silently mismatching one to the other's existing ticket during
// dedup. This 6-hex-char suffix, derived from the *raw* nameVersion, keeps the label human-readable
// while making that collision cryptographically negligible (component labels stay literal, not fully
// hashed, per the design point in CLAUDE.md).
function labelHashSuffix(nameVersion: string): string {
  return createHash('sha256').update(nameVersion).digest('hex').slice(0, LABEL_HASH_LENGTH);
}

export function sanitizeComponentLabel(nameVersion: string): string {
  const sanitized = nameVersion
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  const suffix = `-${labelHashSuffix(nameVersion)}`;
  const readableBudget = MAX_LABEL_LENGTH - 'oss-dep-'.length - suffix.length;
  // Truncating mid-string can land right after a hyphen; strip a trailing one so it doesn't collide
  // with the suffix's own leading hyphen (e.g. "...x-" + "-abc123" would otherwise read "...x--abc123").
  const readable = (sanitized.length > readableBudget ? sanitized.slice(0, readableBudget) : sanitized).replace(/-+$/, '');
  return `oss-dep-${readable}${suffix}`;
}

export function buildLabels(component: WaltzComponent, templateLabels: string[] = []): string[] {
  const own = ['oss-dependency', sanitizeComponentLabel(component.nameVersion)];
  return [...new Set([...own, ...templateLabels])];
}

export function buildSummary(component: WaltzComponent): string {
  return `[OSS] ${component.nameVersion} — ${component.maxVulnRating}`;
}

function sortVulnerabilities(vulns: WaltzVulnerability[]): WaltzVulnerability[] {
  return [...vulns].sort((a, b) => {
    const ratingDiff = vulnRatingRank(b.overallSeverity ?? 'None') - vulnRatingRank(a.overallSeverity ?? 'None');
    if (ratingDiff !== 0) return ratingDiff;
    const scoreDiff = (b.cvssV3Score ?? -1) - (a.cvssV3Score ?? -1);
    if (scoreDiff !== 0) return scoreDiff;
    return a.cveId.localeCompare(b.cveId);
  });
}

// Every value threaded through this function originates in spreadsheet cells the user supplied —
// untrusted input. markdownToJiraWiki() is a simple line-based/regex converter with no
// escape-character support at all (a backslash has no special meaning to it), so neutralizing
// means removing or replacing the characters it treats as structural, not backslash-prefixing them:
//   - embedded newlines are flattened to a space FIRST — the converter re-parses every joined line
//     independently, so an embedded "\n# Fake Heading" or a full "\n| injected | row |" line would
//     otherwise inject a brand-new heading/table/list/quote/code-fence the author never wrote
//   - a literal '|' is replaced — inside one of our own table rows it would silently split into
//     extra cells and misalign the table (the line-based parser just does `line.split('|')`)
//   - '*', '_', '`', '[', ']' are stripped — inline() applies bold/italic/code-span/link formatting
//     anywhere in a line (not just at line-start), so a crafted CVE summary can't render a fake
//     clickable link, or bold/italic text the author never wrote
function sanitizeCellText(value: string): string {
  return value
    .replace(/\r\n|\r|\n/g, ' ')
    .replace(/\|/g, '/')
    .replace(/[*_`[\]]/g, '');
}

// Authored as Markdown (headings, bullets, a real pipe table) and converted once at the end via
// markdownToJiraWiki() — avoids hand-writing Jira's ||table|| syntax; use **bold** (not Jira's
// single-asterisk bold) in the Markdown source since the converter's inline() pass would otherwise
// mistake a lone-asterisk span for italics.
export function buildDescriptionWiki(component: WaltzComponent): string {
  const lines: string[] = [];
  const sorted = sortVulnerabilities(component.vulnerabilities);

  lines.push('### Max Vuln Rating');
  lines.push(sanitizeCellText(component.maxVulnRating));
  lines.push('');

  // Surfaces *why* this ticket exists at a glance, ahead of the full artifact/CVE lists below.
  lines.push('### Most Critical Vulnerability');
  if (sorted.length === 0) {
    lines.push('No CVE-level detail was reported for this component.');
  } else {
    const top = sorted[0];
    lines.push(`**${sanitizeCellText(top.cveId)}** — ${sanitizeCellText(top.cveSummary ?? 'No summary reported.')}`);
  }
  lines.push('');

  const artifactTotal = component.instancePaths.length;
  lines.push(`### Affected artifacts (${artifactTotal} total${artifactTotal > MAX_ARTIFACTS_SHOWN ? ` — showing top ${MAX_ARTIFACTS_SHOWN}` : ''})`);
  if (artifactTotal === 0) {
    lines.push('No affected artifact paths were reported for this component.');
  } else {
    for (const p of component.instancePaths.slice(0, MAX_ARTIFACTS_SHOWN)) lines.push(`- ${sanitizeCellText(p)}`);
    if (artifactTotal > MAX_ARTIFACTS_SHOWN) lines.push(`+${artifactTotal - MAX_ARTIFACTS_SHOWN} more not shown`);
  }
  lines.push('');

  const total = component.vulnerabilities.length;
  lines.push(`### Known vulnerabilities (${total} total${total > MAX_CVES_SHOWN ? ` — showing top ${MAX_CVES_SHOWN}` : ''})`);
  if (total === 0) {
    lines.push('No CVE-level detail was reported for this component.');
  } else {
    lines.push('| CVE | Severity | CVSS | Fixed Version |');
    lines.push('| --- | --- | --- | --- |');
    for (const v of sorted.slice(0, MAX_CVES_SHOWN)) {
      const score = v.cvssV3Score != null ? String(v.cvssV3Score) : 'n/a';
      lines.push(`| ${sanitizeCellText(v.cveId)} | ${sanitizeCellText(v.overallSeverity ?? 'Unknown')} | ${score} | ${sanitizeCellText(v.fixedVersion ?? 'n/a')} |`);
    }
    if (total > MAX_CVES_SHOWN) {
      lines.push('');
      lines.push(`+${total - MAX_CVES_SHOWN} more not shown`);
    }
  }
  lines.push('');
  lines.push('### Component');
  lines.push(sanitizeCellText(component.nameVersion));

  return markdownToJiraWiki(lines.join('\n'));
}

export const DEDUP_CHUNK_SIZE = 40;

// Defined here (alongside the other batch-shaped constants) and imported by waltzHandler.ts, rather
// than duplicated as a local constant there, so the ticket-creation cap and the review-screen
// truncation applied in waltzHandler.ts can never drift apart. Traces back to reportImport.ts's
// shared BATCH_LIMIT (KTD4) — value unchanged (50).
export const BATCH_LIMIT = SHARED_BATCH_LIMIT;

// The functions below are thin wrappers (behavior/signature unchanged) delegating to the shared
// primitives in reportImport.ts — Waltz's own chunking/JQL-quoting/dedup-key shape already matches
// the generalized versions exactly (see CLAUDE.md's shared report-import utilities note / KTD2).
export function chunkComponentLabels(labels: string[]): string[][] {
  return chunkStrings(labels, DEDUP_CHUNK_SIZE);
}

export function buildDedupJql(projectKey: string, labels: string[]): string {
  return buildDedupJqlShared(projectKey, labels);
}

export function extractDedupMap(issues: JqlIssueLike[]): Map<string, string> {
  return extractDedupMapShared(issues, label => (label.startsWith('oss-dep-') ? label : null));
}

// Lives here (rather than in sessionState.ts, where the other session-related types live) so that
// buildReviewRows() below can produce it directly without a type-only circular import between this
// file and sessionState.ts — mirrors the same layout decision made for VeracodeReviewRow.
// sessionState.ts re-exports the type for callers that expect it there.
export interface WaltzReviewRow {
  id: string; // '1'..'N' new candidates, 'A1'..'Am' already-ticketed
  nameVersion: string;
  maxVulnRating: string;
  summary: string;
  labels: string[];
  descriptionWiki: string;
  existingTicketKey: string | null;
  included: boolean; // whether this row will be (re)created if the batch runs
}

export function buildReviewRows(
  components: WaltzComponent[],
  dedupMap: Map<string, string>,
  templateLabels: string[] = [],
): WaltzReviewRow[] {
  return buildReviewRowsShared<WaltzComponent, WaltzReviewRow>(
    components,
    dedupMap,
    component => sanitizeComponentLabel(component.nameVersion),
    component => ({
      nameVersion: component.nameVersion,
      maxVulnRating: component.maxVulnRating,
      summary: buildSummary(component),
      labels: buildLabels(component, templateLabels),
      descriptionWiki: buildDescriptionWiki(component),
    }),
  );
}
