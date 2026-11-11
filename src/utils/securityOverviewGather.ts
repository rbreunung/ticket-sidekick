import type { TicketService } from '../services/TicketService';
import type { DiagLogger } from './diagTypes';
import { localDate, type OverviewInput } from './securityOverview';

// Everything the security overview needs from Jira for one project: tickets, release dates and
// descriptions. Shared by `@jira /security-report`, which streams the warnings into the chat, and
// the security report canvas, which shows them under its title. No `vscode` import.

/** Something the reader should know about the reading, shown before the tables. */
export type OverviewWarning =
  | { kind: 'truncated'; shown: number }
  | { kind: 'release-dates-unread' };

export type GatherResult =
  | { ok: true; input: OverviewInput; warnings: OverviewWarning[] }
  /** The ticket search failed; `error` is what Jira's client threw. */
  | { ok: false; error: unknown };

/** The one wording of each warning, in the chat and on the page. */
export function overviewWarningText(warning: OverviewWarning): string {
  return warning.kind === 'truncated'
    ? `More tickets matched than can be listed; showing the first ${warning.shown}.`
    : 'Warning: could not read the release dates, so nothing is flagged as due before its release.';
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function gatherOverview(
  ticketService: TicketService,
  projectKey: string,
  baseUrl?: string,
  onDiag?: DiagLogger,
): Promise<GatherResult> {
  let list;
  try {
    list = await ticketService.listOverviewTickets(projectKey);
  } catch (err) {
    onDiag?.('error', 'Overview search failed', { projectKey, error: messageOf(err) });
    return { ok: false, error: err };
  }
  const warnings: OverviewWarning[] = [];
  if (list.truncated) warnings.push({ kind: 'truncated', shown: list.tickets.length });

  let versions: Awaited<ReturnType<TicketService['getProjectVersions']>> = [];
  try {
    versions = await ticketService.getProjectVersions(projectKey);
  } catch (err) {
    onDiag?.('warn', 'Could not read the project versions — release dates are not used', { projectKey, error: messageOf(err) });
    warnings.push({ kind: 'release-dates-unread' });
  }

  const { texts, failed } = await ticketService.readDescriptions(
    list.tickets.map(t => t.key),
    (key, err) => onDiag?.('warn', `Could not read the description of ${key}`, { issueKey: key, error: messageOf(err) }),
  );
  if (failed.length > 0) onDiag?.('warn', 'Some descriptions could not be read', { failed: failed.length });

  return { ok: true, input: { tickets: list.tickets, descriptions: texts, versions, today: localDate(), baseUrl, projectKey }, warnings };
}
