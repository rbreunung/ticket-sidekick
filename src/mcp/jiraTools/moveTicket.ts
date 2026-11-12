import { z } from 'zod';
import { fingerprint } from '../../tools/recentCallGuard';
import { discoverAndCacheWorkflow, resolveAndApplyTransition, type TransitionResolution } from '../../services/WorkflowService';
import { defineTool, ToolFailure, toolErrorLabel } from '../mcpServer';
import type { JiraToolDeps } from './jiraAccess';
import { describeJiraFailure, formatSeconds, JiraTimeout, runJiraTool, WRITE_TIMEOUT_LABEL } from './runJiraTool';
import { ticketKeyProblem } from './ticketKeyInput';
import { MOVE_TICKET_TOOL, VIEW_TICKET_TOOL } from './toolNames';
import { writeOnce } from './writeGuard';

// Moves a ticket to a status, directly or along the workflow cached in the first workspace
// folder (`.jira-workflow-cache.json`, the cache `@jira` uses). When no path to the status is
// found, the workflow is discovered from Jira once and the move tried again.

const moveShape = {
  ticketKey: z.string().describe('The ticket key, e.g. PROJ-123.'),
  targetStatus: z.string().describe('The status to move the ticket to, e.g. "In Review" or "Done".'),
  resolution: z.string().optional().describe('The resolution to set when the last step asks for one, e.g. "Fixed".'),
};

/** The answer to a move that ended; one that stopped partway is a failure (partialFailureAnswer). */
function describeMove(key: string, result: Exclude<TransitionResolution, { kind: 'partialFailure' }>, discovered: boolean): string {
  const discoveryNote = discovered ? ' The workflow was discovered from Jira and saved to `.jira-workflow-cache.json` first.' : '';
  switch (result.kind) {
    case 'alreadyThere':
      return `${key} is already in ${result.currentStatus}. Nothing was changed.`;
    case 'direct':
      return `${key} moved from ${result.fromStatus} to ${result.toStatus} (transition "${result.steps[0]}").${discoveryNote}`;
    case 'multiHop':
      return `${key} moved from ${result.fromStatus} to ${result.toStatus} in ${result.hops} steps: ${result.steps.join(' → ')}.${discoveryNote}`;
    case 'unavailable': {
      const available = result.available.length > 0 ? ` Statuses it can reach in one step: ${result.available.join(', ')}.` : '';
      const cause = discovered ? ' even in the workflow discovered from Jira just now' : '';
      return `${key} cannot be moved from ${result.currentStatus} to the target status: no path was found${cause}.${available}`;
    }
  }
}

/**
 * A move that stopped after some steps, as a failed tool call: where the ticket was last
 * confirmed, which step failed and why, with no Jira or proxy response body. A step that got no
 * answer in time may still go through, so the answer says so and does not name a current status.
 */
function partialFailureAnswer(key: string, result: Extract<TransitionResolution, { kind: 'partialFailure' }>): ToolFailure {
  const progress = `${key} moved partway: after ${result.completedHops} of ${result.totalHops} steps it was last confirmed in ${result.landedStatus}; `;
  if (result.cause instanceof JiraTimeout) {
    return new ToolFailure(
      `${progress}the step towards ${result.targetStatus} got no answer within ${formatSeconds(result.cause.timeoutMs)} and may still go through. `
      + `The move was not retried; view the ticket with ${VIEW_TICKET_TOOL} before trying again.`,
      WRITE_TIMEOUT_LABEL,
    );
  }
  return new ToolFailure(
    `${progress}the step towards ${result.targetStatus} failed: ${describeJiraFailure(result.cause)} `
    + `The move was not retried; view the ticket with ${VIEW_TICKET_TOOL} before trying again.`,
    toolErrorLabel(result.cause),
  );
}

export const moveTicketTool = defineTool<JiraToolDeps, typeof moveShape>({
  name: MOVE_TICKET_TOOL,
  title: 'Move a Jira ticket to another status',
  description:
    'Moves one Jira ticket to a target status, in one transition or along several when the workflow needs them. '
    + 'To move several tickets, open the ticket-list canvas with the move as input.change; do not call this once per ticket. '
    + 'When no path is known yet, it discovers the workflow from Jira first, by sampling tickets, and saves it to the workspace cache. '
    + 'The answer names the status the ticket came from and every transition taken. A move that stops partway says where the ticket landed '
    + 'and is never retried. The same move within a minute is skipped.',
  inputSchema: moveShape,
  annotations: { destructiveHint: true },
  handler: async (args, deps) => {
    const key = args.ticketKey.trim();
    const target = args.targetStatus.trim();
    const problem = ticketKeyProblem(key);
    if (problem) return problem;
    if (!target) return 'A target status is required, e.g. "Done".';
    const resolution = args.resolution?.trim() || undefined;

    return writeOnce(
      deps.recentWrites,
      fingerprint(MOVE_TICKET_TOOL, key, target.toLowerCase(), resolution ?? ''),
      `Skipped: ${key} was moved to ${target} within the last minute. View it with ${VIEW_TICKET_TOOL}, or wait a minute to move it again.`,
      markWritten => runJiraTool(deps, MOVE_TICKET_TOOL, `Could not move ${key}`, async ({ access, ticketService }) => {
        const folder = deps.workspaceFolders()[0];
        const move = () => resolveAndApplyTransition(access.client, ticketService, folder ?? '', key, target, resolution);
        let result = await move();
        let discovered = false;
        // No direct transition and no cached path: discover the workflow once, then try again.
        if (result.kind === 'unavailable' && folder && result.issueType) {
          const discovery = await discoverAndCacheWorkflow(access.client, folder, result.projectKey, result.issueType);
          if (Object.keys(discovery.graph).length > 0) {
            deps.onDiag?.('info', 'Workflow discovered for a move', { statusCount: Object.keys(discovery.graph).length });
            discovered = true;
            result = await move();
          }
        }
        if (result.kind === 'partialFailure') {
          const status = (result.cause as { status?: unknown } | null)?.status;
          deps.onDiag?.('error', `${MOVE_TICKET_TOOL}: move stopped partway`, {
            completedHops: result.completedHops,
            totalHops: result.totalHops,
            lastConfirmedStatus: result.landedStatus,
            targetStatus: result.targetStatus,
            discovered,
            ...(typeof status === 'number' ? { status } : {}),
            timedOut: result.cause instanceof JiraTimeout,
            error: result.cause instanceof Error ? result.cause.message : String(result.cause),
          });
          throw partialFailureAnswer(key, result);
        }
        if (result.kind === 'direct' || result.kind === 'multiHop') markWritten();
        deps.onDiag?.('info', `Move ended: ${result.kind}`);
        return describeMove(key, result, discovered);
      }),
    );
  },
});
