import { logDiag } from '../../utils/diagLog';
import type { IJiraClient } from '../../jira/IJiraClient';
import type { TicketService } from '../../services/TicketService';
import { loadWorkflowCache } from '../../services/WorkflowService';
import { TemplateService } from '../../templates/TemplateService';
import type { CleanupRule } from '../../templates/TemplateService';
import type {
  TransitionBatchTicket,
  StaleTicketGroup, IneligibleStaleTicket,
} from '../sessionState';
import type { StaleTicketMatch } from '../../utils/reportImport';

export interface TransitionRunResult {
  transitioned: number;
  failed: number;
  skipped: number;
  failures: Array<{ key: string; reason: string }>;
}

/**
 * Runs `ticketService.transitionAlongPath` for every INCLUDED ticket (and included subtask) in
 * `tickets`, tolerating individual failures (logged + collected, not thrown). Extracted out of
 * `executeCleanupBatch` (U6/KTD10-15) so `reportImportHandler.ts`'s stale-ticket transition pass —
 * run once per issue-type group, each with its own resolution — can reuse the exact same per-ticket
 * logic instead of re-implementing it. Pure execution only; the caller formats/streams its own
 * summary line from the returned counts (cleanup's own wording and the report-import combined
 * create+transition wording differ, per KTD's "reuse the logic, not necessarily the message").
 */
export async function transitionTickets(
  tickets: TransitionBatchTicket[],
  ticketService: TicketService,
  defaultResolution: string | undefined,
  scope = 'jira.cleanup',
): Promise<TransitionRunResult> {
  let transitioned = 0;
  let failed = 0;
  let skipped = 0;
  const failures: Array<{ key: string; reason: string }> = [];

  // U6: excludes are each ticket's/subtask's own `included` flag (toggled per-row via the review
  // table, R8) rather than a skip-set passed in for this one call.
  for (const ticket of tickets) {
    if (!ticket.included) {
      skipped += 1 + ticket.subtasks.length;
      continue;
    }

    for (const sub of ticket.subtasks) {
      if (!sub.included) { skipped++; continue; }
      try {
        await ticketService.transitionAlongPath(sub.key, sub.transitionPath, sub.resolution ?? defaultResolution);
        transitioned++;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        logDiag(scope, 'warn', `Transition failed — ${sub.key}`, { issueKey: sub.key, reason });
        failures.push({ key: sub.key, reason });
        failed++;
      }
    }

    try {
      await ticketService.transitionAlongPath(ticket.key, ticket.transitionPath, defaultResolution);
      transitioned++;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logDiag(scope, 'warn', `Transition failed — ${ticket.key}`, { issueKey: ticket.key, reason });
      failures.push({ key: ticket.key, reason });
      failed++;
    }
  }

  return { transitioned, failed, skipped, failures };
}

export interface StaleGroupBuildResult {
  groups: StaleTicketGroup[];
  ineligible: IneligibleStaleTicket[];
  /** The instance's resolution names for the close-time resolution question — empty when there are
   * none, when no group is eligible, or when the fetch failed (the close then never asks). */
  resolutionOptions: string[];
}

/**
 * Groups `findStaleTickets()`'s matches by issue type and captures, per group, what the close-time
 * target pick needs (stale-ticket target pick plan, KTD1): every `cleanupRules` entry matching the
 * project + issue type (not only the first), and a snapshot of that project/issue type's cached
 * workflow graph. No target or transition path is chosen here — both happen when the user closes
 * (KTD2), so a group no longer needs a cleanup rule to be closable (R10). `issueDetails` supplies
 * each candidate's summary/status/issue type from the stale search's own result.
 *
 * A ticket whose issue type is unknown, or whose project/issue type has no discovered workflow, is
 * reported into `ineligible` rather than silently dropped. Resolution names are fetched once when
 * at least one group is eligible; a failed fetch degrades to an empty list rather than throwing, so
 * it can't discard the whole stale section in the caller.
 */
export async function buildStaleTicketGroups(
  staleMatches: StaleTicketMatch[],
  issueDetails: Map<string, { summary: string; currentStatus: string; issueType: string }>,
  projectKey: string,
  jiraClient: Pick<IJiraClient, 'getResolutions'>,
  workspaceRoot: string,
  scope = 'jira.cleanup',
): Promise<StaleGroupBuildResult> {
  const { cleanupRules } = new TemplateService(workspaceRoot).loadTemplates();
  const cache = loadWorkflowCache(workspaceRoot);

  const byIssueType = new Map<string, StaleTicketMatch[]>();
  const ineligible: IneligibleStaleTicket[] = [];

  for (const match of staleMatches) {
    const detail = issueDetails.get(match.key);
    if (!detail || !detail.issueType) {
      ineligible.push({
        key: match.key,
        summary: detail?.summary ?? match.key,
        currentStatus: detail?.currentStatus ?? '?',
        note: 'could not determine this ticket\'s issue type — it cannot be transitioned from here',
      });
      continue;
    }
    if (!byIssueType.has(detail.issueType)) byIssueType.set(detail.issueType, []);
    byIssueType.get(detail.issueType)!.push(match);
  }

  const groups: StaleTicketGroup[] = [];
  for (const [issueType, matches] of byIssueType) {
    const graph = cache[projectKey]?.[issueType]?.graph;
    if (!graph) {
      for (const m of matches) {
        const d = issueDetails.get(m.key)!;
        ineligible.push({
          key: m.key, summary: d.summary, currentStatus: d.currentStatus,
          note: `no workflow cache for ${projectKey}/${issueType} — run @jira discover workflow ${projectKey} ${issueType}`,
        });
      }
      continue;
    }
    const rules = cleanupRules
      .filter((r: CleanupRule) => r.project === projectKey && r.issueType === issueType)
      .map((r: CleanupRule) => ({ name: r.name, targetState: r.targetState ?? 'Done', resolution: r.resolution }));
    // `included` defaults false for a stale ticket — nothing transitions without an explicit toggle.
    const tickets: TransitionBatchTicket[] = matches.map((m) => {
      const d = issueDetails.get(m.key)!;
      return { key: m.key, summary: d.summary, currentStatus: d.currentStatus, transitionPath: [], subtasks: [], included: false };
    });
    groups.push({ issueType, rules, graph, tickets });
  }

  let resolutionOptions: string[] = [];
  if (groups.length > 0) {
    try {
      resolutionOptions = (await jiraClient.getResolutions()).map((r) => r.name);
    } catch (err) {
      logDiag(scope, 'warn', 'Could not fetch resolutions for the stale-ticket close — it will not ask for one', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { groups, ineligible, resolutionOptions };
}
