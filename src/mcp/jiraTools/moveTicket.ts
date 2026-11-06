import { z } from 'zod';
import { discoverAndCacheWorkflow, resolveAndApplyTransition, type TransitionResolution } from '../../services/WorkflowService';
import { defineTool } from '../mcpServer';
import type { JiraToolDeps } from './jiraAccess';
import { runJiraTool } from './runJiraTool';
import { ticketKeyProblem } from './ticketKeyInput';
import { MOVE_TICKET_TOOL } from './toolNames';

// Moves a ticket to a status, directly or along the workflow cached in the first workspace
// folder (`.jira-workflow-cache.json`, the cache `@jira` uses). When no path to the status is
// found, the workflow is discovered from Jira once and the move tried again.

const moveShape = {
  ticketKey: z.string().describe('The ticket key, e.g. PROJ-123.'),
  targetStatus: z.string().describe('The status to move the ticket to, e.g. "In Review" or "Done".'),
  resolution: z.string().optional().describe('The resolution to set when the last step asks for one, e.g. "Fixed".'),
};

function describeMove(key: string, result: TransitionResolution, discovered: boolean): string {
  const discoveryNote = discovered ? ' The workflow was discovered from Jira and saved to `.jira-workflow-cache.json` first.' : '';
  switch (result.kind) {
    case 'alreadyThere':
      return `${key} is already in ${result.currentStatus}. Nothing was changed.`;
    case 'direct':
      return `${key} moved from ${result.fromStatus} to ${result.toStatus} (transition "${result.steps[0]}").${discoveryNote}`;
    case 'multiHop':
      return `${key} moved from ${result.fromStatus} to ${result.toStatus} in ${result.hops} steps: ${result.steps.join(' → ')}.${discoveryNote}`;
    case 'partialFailure':
      return `${key} moved partway: it is now in ${result.landedStatus}, after ${result.completedHops} of ${result.totalHops} steps, `
        + `and the next step towards ${result.targetStatus} failed: ${result.error} The move was not retried; `
        + 'check the ticket before trying again.';
    case 'unavailable': {
      const available = result.available.length > 0 ? ` Statuses it can reach in one step: ${result.available.join(', ')}.` : '';
      const cause = discovered ? ' even in the workflow discovered from Jira just now' : '';
      return `${key} cannot be moved from ${result.currentStatus} to the target status: no path was found${cause}.${available}`;
    }
  }
}

export const moveTicketTool = defineTool<JiraToolDeps, typeof moveShape>({
  name: MOVE_TICKET_TOOL,
  title: 'Move a Jira ticket to another status',
  description:
    'Moves a Jira ticket to a target status, in one transition or along several when the workflow needs them. '
    + 'When no path is known yet, it discovers the workflow from Jira first, by sampling tickets, and saves it to the workspace cache. '
    + 'The answer names the status the ticket came from and every transition taken. A move that stops partway says where the ticket landed '
    + 'and is never retried.',
  inputSchema: moveShape,
  annotations: { destructiveHint: true },
  handler: async (args, deps) => {
    const key = args.ticketKey.trim();
    const target = args.targetStatus.trim();
    const problem = ticketKeyProblem(key);
    if (problem) return problem;
    if (!target) return 'A target status is required, e.g. "Done".';
    const resolution = args.resolution?.trim() || undefined;

    return runJiraTool(deps, MOVE_TICKET_TOOL, `Could not move ${key}`, async ({ access, ticketService }) => {
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
      deps.onDiag?.(result.kind === 'partialFailure' ? 'warn' : 'info', `Move ended: ${result.kind}`);
      return describeMove(key, result, discovered);
    });
  },
});
