import * as vscode from 'vscode';
import { logDiag } from '../../utils/diagLog';
import {
  renderOverviewMarkdown, localDate, type Overview, type OverviewFormat,
} from '../../utils/securityOverview';
import { renderOverviewCsv, resolveCsvDelimiter } from '../../utils/securityOverviewCsv';
import { renderOverviewXlsx } from '../../utils/securityOverviewXlsx';
import { buildChatCommandLink } from '../sessionState';
import { trustedChatMarkdown } from '../../utils/chatMarkdown';

const SCOPE = 'jira.overview';

/** The CSV separator the user chose (`ticketSidekick.jira.overviewCsvDelimiter`). */
export function getOverviewCsvDelimiter(): string {
  return resolveCsvDelimiter(vscode.workspace.getConfiguration('ticketSidekick').get('jira.overviewCsvDelimiter'));
}

const FILE_FORMATS: Record<OverviewFormat, { extension: string; filterName: string; label: string }> = {
  csv: { extension: 'csv', filterName: 'CSV', label: 'CSV' },
  xlsx: { extension: 'xlsx', filterName: 'Excel', label: 'Excel file' },
};

/**
 * Writes the overview as CSV or Excel through a save dialog and tells the user where it went. A cancelled dialog writes
 * nothing and says so. Used by the `export csv` / `export xlsx` replies of a report import.
 */
export async function saveOverviewFile(overview: Overview, fileLabel: string, format: OverviewFormat, stream: vscode.ChatResponseStream): Promise<boolean> {
  const { extension, filterName, label } = FILE_FORMATS[format];
  const name = `security-overview-${fileLabel}-${localDate()}.${extension}`;
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
  const target = await vscode.window.showSaveDialog({
    defaultUri: folder ? vscode.Uri.joinPath(folder, name) : vscode.Uri.file(name),
    filters: { [filterName]: [extension] },
    saveLabel: 'Save overview',
  });
  if (!target) {
    stream.markdown('_Save cancelled — nothing was written._');
    return false;
  }
  try {
    const bytes = format === 'xlsx'
      ? await renderOverviewXlsx(overview)
      : new TextEncoder().encode(renderOverviewCsv(overview, getOverviewCsvDelimiter()));
    await vscode.workspace.fs.writeFile(target, bytes);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logDiag(SCOPE, 'error', `Could not write the overview ${label}`, { format, error: message });
    stream.markdown(`Could not save the file: ${message}`);
    return false;
  }
  logDiag(SCOPE, 'info', `Overview ${label} saved`, { format, file: name });
  stream.markdown(`Saved the security report to \`${target.fsPath}\`.`);
  return true;
}

/** Streams the overview tables followed by clickable "Save as CSV" and "Save as Excel" links that send the given `@jira` replies. */
export function streamOverview(overview: Overview, stream: vscode.ChatResponseStream, baseUrl: string | undefined, saveReplies: { csv: string; xlsx: string } | null): void {
  const text = renderOverviewMarkdown(overview, baseUrl);
  const links = saveReplies && overview.tables.length > 0
    ? `\n\n${buildChatCommandLink('Save as CSV', '@jira', saveReplies.csv)} · ${buildChatCommandLink('Save as Excel', '@jira', saveReplies.xlsx)}`
    : '';
  stream.markdown(trustedChatMarkdown(text + links));
}
