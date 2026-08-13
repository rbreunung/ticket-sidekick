import { readSheet, parseSheetData, SheetNotFoundError } from 'read-excel-file/node';

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

const MAX_REPORT_BYTES = 20 * 1024 * 1024; // 20 MB
const REQUIRED_SHEET = 'ComponentRemediations';

export function assertSafeWaltzReportSize(buffer: Buffer): void {
  if (buffer.length > MAX_REPORT_BYTES) {
    throw new Error(`OSS report exceeds the ${MAX_REPORT_BYTES / (1024 * 1024)} MB size limit.`);
  }
}

const componentRemediationsSchema = {
  nameVersion: { column: 'Component name and version', type: String, required: true },
  maxVulnRating: { column: 'Max Vuln Rating', type: String, required: true },
  remediationAction: { column: 'Remediation Action', type: String, required: false },
};

const versionInstancesSchema = {
  nameVersion: { column: 'Component name and version', type: String, required: true },
  instancePath: { column: 'Component Instance Path', type: String, required: false },
};

const vulnerabilitiesSchema = {
  nameVersion: { column: 'Component name and version', type: String, required: true },
  cveId: { column: 'CVE Id', type: String, required: true },
  cveSummary: { column: 'CVE Summary', type: String, required: false },
  overallSeverity: { column: 'Overall Severity', type: String, required: false },
  cvssV3Score: { column: 'CVSS_V3 severity base score', type: Number, required: false },
  fixedVersion: { column: 'Fixed Version', type: String, required: false },
};

// Reads one sheet by name and parses it against a schema — read-excel-file's readSheet() can't
// combine `sheet` + `schema` in a single call (verified against the installed .d.ts in Task 1),
// so this is a deliberate two-step helper, not an oversight.
async function readNamedSheet<T extends object>(
  buffer: Buffer,
  sheetName: string,
  schema: Record<string, unknown>,
): Promise<T[]> {
  const sheetData = await readSheet(buffer, sheetName);
  const { objects, errors } = parseSheetData<T>(sheetData, schema as never);
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
  schema: Record<string, unknown>,
): Promise<T[]> {
  try {
    return await readNamedSheet<T>(buffer, sheetName, schema);
  } catch (err) {
    if (err instanceof SheetNotFoundError) return [];
    throw err;
  }
}

const PARSE_TIMEOUT_MS = 15_000; // hard ceiling so a pathological file (e.g. a decompression-bomb-style
// worksheet entry — see CLAUDE.md "Security notes") fails fast instead of exhausting memory or hanging
// the extension host. Bounds wall-clock time, not memory directly, but a hung/thrashing parse is
// exactly what this catches.

export async function parseWaltzReport(buffer: Buffer): Promise<WaltzComponent[]> {
  return Promise.race([
    parseWaltzReportInner(buffer),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`OSS report parsing exceeded ${PARSE_TIMEOUT_MS / 1000}s — the file may be malformed or unusually large.`)),
        PARSE_TIMEOUT_MS,
      ),
    ),
  ]);
}

async function parseWaltzReportInner(buffer: Buffer): Promise<WaltzComponent[]> {
  assertSafeWaltzReportSize(buffer);

  let remediations: Array<{ nameVersion: string; maxVulnRating: string; remediationAction: string | null }>;
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

  const instances = await readOptionalNamedSheet<{ nameVersion: string; instancePath: string | null }>(
    buffer, 'VersionInstances', versionInstancesSchema,
  );
  const vulnerabilities = await readOptionalNamedSheet<{
    nameVersion: string; cveId: string; cveSummary: string | null;
    overallSeverity: string | null; cvssV3Score: number | null; fixedVersion: string | null;
  }>(buffer, 'Vulnerabilities', vulnerabilitiesSchema);

  return remediations.map(r => ({
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
