import * as vscode from 'vscode';
import { logDiag } from '../../utils/diagLog';
import type { TicketService } from '../../services/TicketService';
import {
  buildOverview, renderOverviewMarkdown, parseOverviewPrompt, localDate, type Overview, type OverviewInput,
} from '../../utils/securityOverview';
import { renderOverviewCsv, resolveCsvDelimiter } from '../../utils/securityOverviewCsv';
import { buildChatCommandLink } from '../sessionState';
import { trustedChatMarkdown } from '../../utils/chatMarkdown';
import { resolveProjectKey } from './ticketContext';

const SCOPE = 'jira.overview';

/** The CSV separator the user chose (`ticketSidekick.jira.overviewCsvDelimiter`). */
export function getOverviewCsvDelimiter(): string {
  return resolveCsvDelimiter(vscode.workspace.getConfiguration('ticketSidekick').get('jira.overviewCsvDelimiter'));
}

/**
 * Writes the overview as CSV through a save dialog and tells the user where it went. A cancelled dialog writes
 * nothing and says so. Shared by the standalone command and the `export csv` reply of a report import.
 */
export async function saveOverviewCsv(overview: Overview, fileLabel: string, stream: vscode.ChatResponseStream): Promise<boolean> {
  const name = `security-overview-${fileLabel}-${localDate()}.csv`;
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
  const target = await vscode.window.showSaveDialog({
    defaultUri: folder ? vscode.Uri.joinPath(folder, name) : vscode.Uri.file(name),
    filters: { CSV: ['csv'] },
    saveLabel: 'Save overview',
  });
  if (!target) {
    stream.markdown('_Save cancelled — nothing was written._');
    return false;
  }
  try {
    await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(renderOverviewCsv(overview, getOverviewCsvDelimiter())));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logDiag(SCOPE, 'error', 'Could not write the overview CSV', { error: message });
    stream.markdown(`Could not save the file: ${message}`);
    return false;
  }
  logDiag(SCOPE, 'info', 'Overview CSV saved', { file: name });
  stream.markdown(`Saved the overview to \`${target.fsPath}\`.`);
  return true;
}

/** Streams the overview tables followed by a clickable "Save as CSV" link that re-runs `csvCommand`. */
export function streamOverview(overview: Overview, stream: vscode.ChatResponseStream, baseUrl: string | undefined, csvCommand: { participantReply: string } | null): void {
  const text = renderOverviewMarkdown(overview, baseUrl);
  const link = csvCommand && overview.tables.length > 0
    ? `\n\n${buildChatCommandLink('Save as CSV', '@jira', csvCommand.participantReply)}`
    : '';
  stream.markdown(trustedChatMarkdown(text + link));
}

/** Everything the overview needs from Jira for one project: tickets, release dates and descriptions. Null when the search fails. */
export async function gatherOverviewInput(
  ticketService: TicketService,
  projectKey: string,
  stream: vscode.ChatResponseStream,
  baseUrl?: string,
): Promise<OverviewInput | null> {
  stream.markdown(`_Searching ${projectKey} for open Veracode and Waltz tickets…_\n\n`);
  let list;
  try {
    list = await ticketService.listOverviewTickets(projectKey);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logDiag(SCOPE, 'error', 'Overview search failed', { projectKey, error: message });
    stream.markdown(`Could not search ${projectKey}: ${message}`);
    return null;
  }
  if (list.truncated) stream.markdown(`_More tickets matched than can be listed; showing the first ${list.tickets.length}._\n\n`);

  let versions: Awaited<ReturnType<TicketService['getProjectVersions']>> = [];
  try {
    versions = await ticketService.getProjectVersions(projectKey);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logDiag(SCOPE, 'warn', 'Could not read the project versions — release dates are not used', { projectKey, error: message });
    stream.markdown('_Warning: could not read the release dates, so nothing is flagged as due before its release._\n\n');
  }

  const { texts, failed } = await ticketService.readDescriptions(
    list.tickets.map(t => t.key),
    (key, err) => logDiag(SCOPE, 'warn', `Could not read the description of ${key}`, { issueKey: key, error: err instanceof Error ? err.message : String(err) }),
  );
  if (failed.length > 0) logDiag(SCOPE, 'warn', 'Some descriptions could not be read', { failed: failed.length });

  return { tickets: list.tickets, descriptions: texts, versions, today: localDate(), baseUrl, projectKey };
}

/**
 * `@jira /overview [PROJECT] [csv]`: the project's unresolved Veracode and Waltz tickets by Fix Version. A prompt ending in
 * `csv` (the "Save as CSV" link) builds the same overview again and saves it as a file, so nothing is stored between turns.
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
    stream.markdown('Please name a project, e.g. `@jira /overview PROJ`.');
    return;
  }
  const input = await gatherOverviewInput(ticketService, projectKey, stream, baseUrl);
  if (!input) return;

  const overview = buildOverview(input);
  logDiag(SCOPE, 'info', `Overview built — ${projectKey}`, {
    projectKey, tickets: overview.ticketCount, tables: overview.tables.length, unread: overview.unreadCount, csv: parsed.csv,
  });
  if (parsed.csv) {
    if (overview.tables.length === 0) {
      stream.markdown(renderOverviewMarkdown(overview, baseUrl));
      return;
    }
    await saveOverviewCsv(overview, projectKey, stream);
    return;
  }
  streamOverview(overview, stream, baseUrl, { participantReply: `/overview ${projectKey} csv` });
}
