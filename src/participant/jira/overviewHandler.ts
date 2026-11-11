import * as vscode from 'vscode';
import { logDiag } from '../../utils/diagLog';
import type { TicketService } from '../../services/TicketService';
import {
  buildOverview, renderOverviewMarkdown, parseOverviewPrompt, localDate, type Overview, type OverviewFormat, type OverviewInput,
} from '../../utils/securityOverview';
import { renderOverviewCsv, resolveCsvDelimiter } from '../../utils/securityOverviewCsv';
import { renderOverviewXlsx } from '../../utils/securityOverviewXlsx';
import { buildChatCommandLink } from '../sessionState';
import { trustedChatMarkdown } from '../../utils/chatMarkdown';
import { resolveProjectKey } from './ticketContext';
import { gatherOverview, overviewWarningText } from '../../utils/securityOverviewGather';

const SCOPE = 'jira.overview';

/** The CSV separator the user chose (`ticketSidekick.jira.overviewCsvDelimiter`). */
export function getOverviewCsvDelimiter(): string {
  return resolveCsvDelimiter(vscode.workspace.getConfiguration('ticketSidekick').get('jira.overviewCsvDelimiter'));
}

const FILE_FORMATS: Record<OverviewFormat, { extension: string; filterName: string; label: string }> = {
  csv: { extension: 'csv', filterName: 'CSV', label: 'CSV' },
  xlsx: { extension: 'xlsx', filterName: 'Excel', label: 'Excel file' },
};

/** What a save of the overview came to: the file written, a cancelled dialog, or a failed write with its reason. */
export type OverviewSaveOutcome =
  | { kind: 'saved'; path: string }
  | { kind: 'cancelled' }
  | { kind: 'failed'; reason: string };

/**
 * Writes the overview as CSV or Excel through VS Code's save dialog. A cancelled dialog writes nothing. Shared by the chat
 * (below) and the security report canvas, which shows the outcome on its page.
 */
export async function saveOverviewToFile(overview: Overview, fileLabel: string, format: OverviewFormat): Promise<OverviewSaveOutcome> {
  const { extension, filterName, label } = FILE_FORMATS[format];
  const name = `security-overview-${fileLabel}-${localDate()}.${extension}`;
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
  const target = await vscode.window.showSaveDialog({
    defaultUri: folder ? vscode.Uri.joinPath(folder, name) : vscode.Uri.file(name),
    filters: { [filterName]: [extension] },
    saveLabel: 'Save overview',
  });
  if (!target) return { kind: 'cancelled' };
  try {
    const bytes = format === 'xlsx'
      ? await renderOverviewXlsx(overview)
      : new TextEncoder().encode(renderOverviewCsv(overview, getOverviewCsvDelimiter()));
    await vscode.workspace.fs.writeFile(target, bytes);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logDiag(SCOPE, 'error', `Could not write the overview ${label}`, { format, error: message });
    return { kind: 'failed', reason: message };
  }
  logDiag(SCOPE, 'info', `Overview ${label} saved`, { format, file: name });
  return { kind: 'saved', path: target.fsPath };
}

/**
 * Writes the overview as CSV or Excel through a save dialog and tells the user where it went. A cancelled dialog writes
 * nothing and says so. Shared by the standalone command and the `export csv` / `export xlsx` replies of a report import.
 */
export async function saveOverviewFile(overview: Overview, fileLabel: string, format: OverviewFormat, stream: vscode.ChatResponseStream): Promise<boolean> {
  const outcome = await saveOverviewToFile(overview, fileLabel, format);
  if (outcome.kind === 'cancelled') stream.markdown('_Save cancelled — nothing was written._');
  else if (outcome.kind === 'failed') stream.markdown(`Could not save the file: ${outcome.reason}`);
  else stream.markdown(`Saved the security report to \`${outcome.path}\`.`);
  return outcome.kind === 'saved';
}

/** Streams the overview tables followed by clickable "Save as CSV" and "Save as Excel" links that send the given `@jira` replies. */
export function streamOverview(overview: Overview, stream: vscode.ChatResponseStream, baseUrl: string | undefined, saveReplies: { csv: string; xlsx: string } | null): void {
  const text = renderOverviewMarkdown(overview, baseUrl);
  const links = saveReplies && overview.tables.length > 0
    ? `\n\n${buildChatCommandLink('Save as CSV', '@jira', saveReplies.csv)} · ${buildChatCommandLink('Save as Excel', '@jira', saveReplies.xlsx)}`
    : '';
  stream.markdown(trustedChatMarkdown(text + links));
}

/** Everything the overview needs from Jira for one project, with its warnings streamed into the chat. Null when the search fails. */
export async function gatherOverviewInput(
  ticketService: TicketService,
  projectKey: string,
  stream: vscode.ChatResponseStream,
  baseUrl?: string,
): Promise<OverviewInput | null> {
  stream.markdown(`_Searching ${projectKey} for open Veracode and Waltz tickets…_\n\n`);
  const result = await gatherOverview(ticketService, projectKey, baseUrl, (level, message, details) => logDiag(SCOPE, level, message, details));
  if (!result.ok) {
    stream.markdown(`Could not search ${projectKey}: ${result.error instanceof Error ? result.error.message : String(result.error)}`);
    return null;
  }
  for (const warning of result.warnings) stream.markdown(`_${overviewWarningText(warning)}_\n\n`);
  return result.input;
}

/**
 * `@jira /security-report [PROJECT] [csv|xlsx]`: the project's unresolved Veracode and Waltz tickets by Fix Version. A prompt naming
 * `csv` or `xlsx` (the "Save as" links) builds the same overview again and saves it as a file, so nothing is stored between turns.
 */
export async function handleSecurityOverview(
  request: vscode.ChatRequest,
  stream: vscode.ChatResponseStream,
  ticketService: TicketService,
  baseUrl?: string,
): Promise<void> {
  const parsed = parseOverviewPrompt(request.prompt);
  const projectKey = await resolveProjectKey(parsed.projectKey, stream);
  if (!projectKey) {
    stream.markdown('Please name a project, e.g. `@jira /security-report PROJ`.');
    return;
  }
  const input = await gatherOverviewInput(ticketService, projectKey, stream, baseUrl);
  if (!input) return;

  const overview = buildOverview(input);
  logDiag(SCOPE, 'info', `Overview built — ${projectKey}`, {
    projectKey, tickets: overview.ticketCount, tables: overview.tables.length, unread: overview.unreadCount, format: parsed.format,
  });
  if (parsed.format) {
    if (overview.tables.length === 0) {
      stream.markdown(renderOverviewMarkdown(overview, baseUrl));
      return;
    }
    await saveOverviewFile(overview, projectKey, parsed.format, stream);
    return;
  }
  streamOverview(overview, stream, baseUrl, { csv: `/security-report ${projectKey} csv`, xlsx: `/security-report ${projectKey} xlsx` });
}
