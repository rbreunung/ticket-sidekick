import { createHash } from 'crypto';
import ExcelJS from 'exceljs';
import { markdownToJiraWiki } from './markdownToJiraWiki';
import {
  MAX_REPORT_BYTES as SHARED_MAX_REPORT_BYTES, sanitizeCellText, sanitizeStandaloneLine,
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

// Minimal re-implementation of read-excel-file's Schema<T> shape (column header -> field mapping,
// with required/type validation) — read-excel-file itself was replaced by ExcelJS (see the comment
// on loadWaltzWorkbook() below for why); this keeps the schema declarations unchanged.
type ColumnType = typeof String | typeof Number;
interface ColumnDef {
  column: string;
  type: ColumnType;
  required: boolean;
}
type Schema<T> = { [K in keyof T]: ColumnDef };

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

class SheetNotFoundError extends Error {
  constructor(sheetName: string, availableSheets: string[]) {
    super(`Sheet "${sheetName}" not found. Available sheets: ${availableSheets.join(', ') || '(none)'}`);
    this.name = 'SheetNotFoundError';
  }
}

// Reads a cell as a trimmed string, resolving ExcelJS's richer value shapes (rich text runs,
// hyperlinks, formula results, dates) down to plain text. Blank cells return null so optional
// fields come out as `null` rather than `''`, matching the row interfaces above.
function cellToString(cell: ExcelJS.Cell): string | null {
  const v = cell.value;
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    const obj = v as { text?: unknown; richText?: Array<{ text: string }>; result?: unknown };
    if (Array.isArray(obj.richText)) return obj.richText.map(r => r.text).join('') || null;
    if (typeof obj.text === 'string') return obj.text || null;
    if (obj.result !== undefined) return obj.result === null ? null : String(obj.result);
    return null;
  }
  const s = String(v).trim();
  return s === '' ? null : s;
}

function cellToNumber(cell: ExcelJS.Cell): number | null {
  const v = cell.value;
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'object') {
    const result = (v as { result?: unknown }).result;
    if (typeof result === 'number') return result;
  }
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

// Maps a worksheet's header row (row 1) to 1-based column indexes by header text.
function headerIndex(worksheet: ExcelJS.Worksheet): Map<string, number> {
  const index = new Map<string, number>();
  worksheet.getRow(1).eachCell({ includeEmpty: false }, (cell, colNumber) => {
    const text = cellToString(cell);
    if (text) index.set(text, colNumber);
  });
  return index;
}

// Reads one sheet's data rows against a schema, out of an already-loaded workbook (loadWaltzWorkbook()
// unzips the whole buffer once up front, so — unlike the old read-excel-file-based version of this
// function — this does no I/O and can't itself throw an unzip error).
function readNamedSheet<T extends object>(
  workbook: ExcelJS.Workbook,
  sheetName: string,
  schema: Schema<T>,
): T[] {
  const worksheet = workbook.getWorksheet(sheetName);
  if (!worksheet) {
    throw new SheetNotFoundError(sheetName, workbook.worksheets.map(w => w.name));
  }

  const columns = headerIndex(worksheet);
  const keys = Object.keys(schema) as Array<keyof T>;
  const errors: string[] = [];
  const objects: T[] = [];

  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return; // header row

    const rawValues = keys.map(key => {
      const def = schema[key];
      const colNumber = columns.get(def.column);
      const cell = colNumber ? row.getCell(colNumber) : undefined;
      return cell ? (def.type === Number ? cellToNumber(cell) : cellToString(cell)) : null;
    });
    // A row with nothing in any schema-mapped column (e.g. a trailing formatted-but-empty row) is
    // silently skipped rather than reported as missing every required field.
    if (rawValues.every(v => v === null)) return;

    const obj = {} as T;
    keys.forEach((key, i) => {
      const def = schema[key];
      const value = rawValues[i];
      if (value === null && def.required) {
        errors.push(`row ${rowNumber} column "${def.column}": missing required value`);
      }
      (obj as Record<string, unknown>)[key as string] = value;
    });
    objects.push(obj);
  });

  if (errors.length > 0) {
    throw new Error(`OSS report sheet "${sheetName}" has invalid rows: ${errors.join('; ')}`);
  }
  return objects;
}

// Optional sheets degrade to an empty array instead of failing the whole import.
function readOptionalNamedSheet<T extends object>(
  workbook: ExcelJS.Workbook,
  sheetName: string,
  schema: Schema<T>,
): T[] {
  try {
    return readNamedSheet<T>(workbook, sheetName, schema);
  } catch (err) {
    if (err instanceof SheetNotFoundError) return [];
    throw err;
  }
}

// Unzips + parses the whole workbook once. ExcelJS's `.xlsx.load()` reads the archive via `jszip`,
// which locates entries through the ZIP's End-Of-Central-Directory record (like Excel's own OOXML
// reader) rather than scanning local file headers sequentially. read-excel-file's Node backend used
// `unzipper-esm`, a sequential/streaming ZIP reader that trusts each local file header's declared
// size — real-world exports written by streaming XLSX writers (sizes deferred to a trailing data
// descriptor, a legal ZIP variant Excel itself handles) trip that assumption and throw a ZIP parse
// error even though the file opens fine in Excel. Central-directory-first parsing has no such
// dependency on local-header sizes, which is why this switch fixes that class of real-world file.
async function loadWaltzWorkbook(buffer: Buffer): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  try {
    // exceljs's index.d.ts globally re-declares `interface Buffer extends ArrayBuffer {}`, which
    // conflicts with @types/node's modern generic `Buffer<TArrayBuffer>` and makes every `Buffer`
    // reference in this file — including our own `buffer` parameter above — structurally mismatch
    // itself. A real Node Buffer either way; `any` here is routing around a broken vendored .d.ts,
    // not a runtime-unsafe cast.
    await workbook.xlsx.load(buffer as any);
  } catch (err) {
    throw new Error(`Could not read OSS report: ${err instanceof Error ? err.message : String(err)}`);
  }
  return workbook;
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

  // Unzip once — loadWaltzWorkbook() is the only step that can throw a "Could not read OSS
  // report" (ZIP-level) error; everything below reads from the already-parsed workbook in memory.
  const workbook = await loadWaltzWorkbook(buffer);

  let remediations: ComponentRemediationsRow[];
  try {
    remediations = readNamedSheet(workbook, REQUIRED_SHEET, componentRemediationsSchema);
  } catch (err) {
    if (err instanceof SheetNotFoundError) {
      throw new Error(`OSS report is missing the required "${REQUIRED_SHEET}" sheet. (${err.message})`);
    }
    throw err;
  }

  const instances = readOptionalNamedSheet<VersionInstanceRow>(workbook, 'VersionInstances', versionInstancesSchema);
  const vulnerabilities = readOptionalNamedSheet<VulnerabilityRow>(workbook, 'Vulnerabilities', vulnerabilitiesSchema);

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

// sanitizeCellText()/sanitizeStandaloneLine() (both untrusted-input sanitizers for values that get
// interpolated into the Markdown built here) now live in reportImport.ts as shared primitives — see
// the doc comments there for exactly what each one neutralizes and why.

// Authored as Markdown (headings, bullets, a real pipe table) and converted once at the end via
// markdownToJiraWiki() — avoids hand-writing Jira's ||table|| syntax; use **bold** (not Jira's
// single-asterisk bold) in the Markdown source since the converter's inline() pass would otherwise
// mistake a lone-asterisk span for italics.
export function buildDescriptionWiki(component: WaltzComponent): string {
  const lines: string[] = [];
  const sorted = sortVulnerabilities(component.vulnerabilities);

  lines.push('### Max Vuln Rating');
  lines.push(sanitizeStandaloneLine(component.maxVulnRating));
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
  lines.push(sanitizeStandaloneLine(component.nameVersion));

  return markdownToJiraWiki(lines.join('\n'));
}

// Lives here (rather than in sessionState.ts, where the other session-related types live) so that
// reportImportHandler.ts's shared buildReviewRows() can produce it directly without a type-only
// circular import between this file and sessionState.ts — mirrors the same layout decision made for
// VeracodeReviewRow. sessionState.ts re-exports the type for callers that expect it there.
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
