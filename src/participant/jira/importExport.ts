import * as vscode from 'vscode';
import { logDiag } from '../../utils/diagLog';
import type { TicketService, OverviewTicket } from '../../services/TicketService';
import type { TicketFinding } from '../../utils/veracodeFindingsTable';
import type { TicketComponent } from '../../utils/waltzComponentsTable';
import { buildOverview, localDate, type ReportOnlyItem } from '../../utils/securityOverview';
import type { ReviewRowBase, ReviewSession } from '../sessionState';
import type { ReportImportDescriptor } from './reportImportTypes';
import { saveOverviewCsv, streamOverview } from './overviewHandler';
import { buildExportFollowUp } from '../session/importScreens';
import { trustedChatMarkdown } from '../../utils/chatMarkdown';

/** The report's records for one ticket: the findings or components of every row that points to it, each once. */
function mergeDetail(into: { findings?: TicketFinding[]; components?: TicketComponent[] }, from: { findings?: TicketFinding[]; components?: TicketComponent[] }): void {
  if (from.findings) {
    const seen = new Set((into.findings ??= []).map(f => f.issueId));
    for (const f of from.findings) if (!seen.has(f.issueId)) into.findings.push(f);
  }
  if (from.components) {
    const seen = new Set((into.components ??= []).map(c => c.nameVersion));
    for (const c of from.components) if (!seen.has(c.nameVersion)) into.components.push(c);
  }
}

/**
 * The `export` reply of a report import (KTD3): this one report's items by Fix Version, compared with Jira. The tickets are the
 * open targets of the Already-ticketed rows (tracked) and the Stale tickets (not in this report); the New rows, and the
 * Already-ticketed rows whose tickets are all resolved, are the report's items with no open ticket. The report supplies the detail of every row it holds; a stale ticket's detail is read from its
 * description. With `csv` the same overview is saved as a file. Nothing in the review session changes.
 */
export async function exportImportOverview<TItem, TRow extends ReviewRowBase>(
  session: ReviewSession<TRow>,
  csv: boolean,
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
  descriptor: ReportImportDescriptor<TItem, TRow>,
  baseUrl?: string,
): Promise<void> {
  await buildAndStreamExport(session, csv, ticketService, stream, descriptor, baseUrl);
  // The export is the last thing on screen: the review screen is not printed again, so say how to go on.
  stream.markdown(trustedChatMarkdown(`\n\n${buildExportFollowUp(session.singleGroup === true)}`));
}

async function buildAndStreamExport<TItem, TRow extends ReviewRowBase>(
  session: ReviewSession<TRow>,
  csv: boolean,
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
  descriptor: ReportImportDescriptor<TItem, TRow>,
  baseUrl?: string,
): Promise<void> {
  const exporter = descriptor.overviewExport;
  if (!exporter) {
    stream.markdown('_Export is not available for this import._');
    return;
  }

  const matchByKey: Record<string, 'tracked' | 'stale'> = {};
  const detailByKey: Record<string, { findings?: TicketFinding[]; components?: TicketComponent[] }> = {};
  const reportOnly: ReportOnlyItem[] = [];
  for (const row of session.allRows) {
    if (row.target && !row.target.resolved) {
      matchByKey[row.target.key] = 'tracked';
      mergeDetail(detailByKey[row.target.key] ??= {}, exporter.detailOf(row));
    } else {
      // No ticket yet, or every ticket of the item is resolved: the report still holds the item, and nothing open tracks it.
      reportOnly.push({ source: exporter.source, summary: exporter.summaryOf(row), dueDate: exporter.dueDateOf(row), ...exporter.detailOf(row) });
    }
  }
  const staleKeys = [
    ...(session.staleTickets?.groups.flatMap(g => g.tickets.map(t => t.key)) ?? []),
    ...(session.staleTickets?.ineligible.map(t => t.key) ?? []),
  ].filter(key => !(session.staleTickets?.closedKeys ?? []).includes(key));
  for (const key of staleKeys) matchByKey[key] ??= 'stale';

  stream.markdown('_Reading the tickets from Jira…_\n\n');
  const keys = Object.keys(matchByKey);
  let tickets: OverviewTicket[] = [];
  try {
    tickets = await ticketService.getOverviewTicketsByKeys(keys, exporter.source);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logDiag(descriptor.scope, 'error', 'Export could not read the tickets', { error: message });
    stream.markdown(`Could not read the tickets from Jira: ${message}`);
    return;
  }
  let versions: Awaited<ReturnType<TicketService['getProjectVersions']>> = [];
  try {
    versions = await ticketService.getProjectVersions(session.projectKey);
  } catch (err) {
    logDiag(descriptor.scope, 'warn', 'Export could not read the project versions — release dates are not used', {
      projectKey: session.projectKey, error: err instanceof Error ? err.message : String(err),
    });
    stream.markdown('_Warning: could not read the release dates, so nothing is flagged as due before its release._\n\n');
  }
  const { texts } = await ticketService.readDescriptions(
    tickets.filter(t => matchByKey[t.key] === 'stale' && !(t.key in detailByKey)).map(t => t.key),
    (key, err) => logDiag(descriptor.scope, 'warn', `Could not read the description of ${key}`, { issueKey: key, error: err instanceof Error ? err.message : String(err) }),
  );

  const overview = buildOverview({
    tickets,
    descriptions: texts,
    versions,
    today: localDate(),
    baseUrl,
    projectKey: session.projectKey,
    report: { matchByKey, reportOnly, detailByKey },
  });
  logDiag(descriptor.scope, 'info', `${descriptor.importLabel} export built`, {
    tickets: tickets.length, reportOnly: reportOnly.length, stale: staleKeys.length, csv,
  });
  if (csv && overview.tables.length > 0) {
    await saveOverviewCsv(overview, exporter.source, stream);
    return;
  }
  streamOverview(overview, stream, baseUrl, { participantReply: IMPORT_EXPORT_CSV_REPLY });
}

/** What the "Save as CSV" link sends back into the review session. */
export const IMPORT_EXPORT_CSV_REPLY = 'export csv';
