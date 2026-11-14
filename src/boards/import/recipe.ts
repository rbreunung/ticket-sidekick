import * as path from 'path';
import { normalizeProjectKey } from '../../services/configValidation';
import { sessionIdFor } from '../../sessions/sessionId';

// What an import board is opened with: the report kind, the Jira project, the report file, the
// template and the issue type. The session id comes from kind, project and report path only, so
// asking again for the same file in the same project finds the same session, with the template it
// was started with. vscode-free.

export const IMPORT_KIND = 'import';

export const REPORT_KINDS = ['veracode', 'waltz'] as const;
export type ReportKind = typeof REPORT_KINDS[number];

export const REPORT_KIND_LABELS: Record<ReportKind, string> = { veracode: 'Veracode', waltz: 'Waltz OSS' };

export interface ImportRecipe {
  kind: ReportKind;
  projectKey: string;
  /** Normalised and absolute (`normaliseReportPath`). */
  reportPath: string;
  templateName: string;
  issueType: string;
}

export function isReportKind(value: unknown): value is ReportKind {
  return typeof value === 'string' && (REPORT_KINDS as readonly string[]).includes(value);
}

/** The report path as the recipe keeps it: absolute, with `.` and `..` resolved and the platform's separators. */
export function normaliseReportPath(filePath: string): string {
  return path.resolve(path.normalize(filePath));
}

/** The source a session id is derived from. Windows paths compare without case, as the file system does. */
export function importSourceKey(source: Pick<ImportRecipe, 'kind' | 'projectKey' | 'reportPath'>): string {
  const reportPath = normaliseReportPath(source.reportPath);
  const project = normalizeProjectKey(source.projectKey) ?? source.projectKey.trim().toUpperCase();
  return [source.kind, project, process.platform === 'win32' ? reportPath.toLowerCase() : reportPath].join('\n');
}

/** The id of the import session for this kind, project and report file. */
export function importSessionId(source: Pick<ImportRecipe, 'kind' | 'projectKey' | 'reportPath'>): string {
  return sessionIdFor(IMPORT_KIND, importSourceKey(source));
}
