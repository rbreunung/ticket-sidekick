import * as path from 'path';
import { normalizeProjectKey } from '../../services/configValidation';
import { sessionIdFor } from '../../sessions/sessionId';

// What an import board is opened with: the report kind, the Jira project, the report file (for an
// email import, the email files), the template and the issue type. The session id comes from kind,
// project and the file paths only, so asking again for the same files in the same project finds the
// same session, with the template it was started with. vscode-free.

export const IMPORT_KIND = 'import';

export const REPORT_KINDS = ['veracode', 'waltz', 'email'] as const;
export type ReportKind = typeof REPORT_KINDS[number];

export const REPORT_KIND_LABELS: Record<ReportKind, string> = { veracode: 'Veracode', waltz: 'Waltz OSS', email: 'Email' };

export interface ImportRecipe {
  kind: ReportKind;
  projectKey: string;
  /** Normalised and absolute (`normaliseReportPath`). For an email import, the first of `reportPaths`. */
  reportPath: string;
  /** An email import's `.eml` files: normalised, absolute and sorted. Absent for the other kinds. */
  reportPaths?: string[];
  /** The emails were dragged into the chat, which counts as agreeing to send them to the model. */
  emailConsent?: boolean;
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

/** The email files of an email import as the recipe keeps them: normalised, absolute, without repeats, sorted. */
export function normaliseEmailPaths(filePaths: string[]): string[] {
  return [...new Set(filePaths.map(normaliseReportPath))].sort();
}

/** Every file an import reads: the report, or an email import's emails. */
export function recipePaths(recipe: Pick<ImportRecipe, 'reportPath' | 'reportPaths'>): string[] {
  return recipe.reportPaths && recipe.reportPaths.length > 0 ? recipe.reportPaths : [recipe.reportPath];
}

/** The source a session id is derived from. Windows paths compare without case, as the file system does. */
export function importSourceKey(source: Pick<ImportRecipe, 'kind' | 'projectKey' | 'reportPath' | 'reportPaths'>): string {
  const files = source.kind === 'email' ? normaliseEmailPaths(recipePaths(source)) : [normaliseReportPath(source.reportPath)];
  const project = normalizeProjectKey(source.projectKey) ?? source.projectKey.trim().toUpperCase();
  return [source.kind, project, ...files.map(f => (process.platform === 'win32' ? f.toLowerCase() : f))].join('\n');
}

/** The id of the import session for this kind, project and report file (or email files). */
export function importSessionId(source: Pick<ImportRecipe, 'kind' | 'projectKey' | 'reportPath' | 'reportPaths'>): string {
  return sessionIdFor(IMPORT_KIND, importSourceKey(source));
}

/** The recipe with its report file at another place: what "Pick the file again" opens the session with. */
export function withReportPath(recipe: ImportRecipe, filePath: string): ImportRecipe {
  const reportPath = normaliseReportPath(filePath);
  // An email import is not found only when none of its files is there: the picked file replaces them.
  return recipe.kind === 'email' ? { ...recipe, reportPath, reportPaths: [reportPath] } : { ...recipe, reportPath };
}

/** An email import's recipe over its files. */
export function emailRecipe(recipe: Omit<ImportRecipe, 'kind' | 'reportPath' | 'reportPaths'>, filePaths: string[]): ImportRecipe {
  const reportPaths = normaliseEmailPaths(filePaths);
  return { ...recipe, kind: 'email', reportPath: reportPaths[0], reportPaths };
}
