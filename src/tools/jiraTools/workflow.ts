import { z } from 'zod';
import {
  discoverAndCacheWorkflow,
  findPath,
  findReachableStatuses,
  loadWorkflowCache,
  type WorkflowGraph,
} from '../../services/WorkflowService';
import { isSafePathSegment } from '../../tools/pathSafety';
import { defineTool } from '../toolDefinition';
import type { JiraToolDeps } from './jiraAccess';
import { runJiraTool } from './runJiraTool';
import { WORKFLOW_TOOL } from './toolNames';

// The statuses a ticket can reach, read from the workflow cache in the first workspace folder
// (`.jira-workflow-cache.json`, the same cache `@jira` uses). When the cache has no workflow for
// the ticket's project and issue type, or not its current status, or a refresh is asked for, the
// workflow is discovered from Jira and the cache rewritten first.

const workflowShape = {
  ticketKey: z.string().describe('The ticket key, e.g. PROJ-123.'),
  refresh: z.boolean().optional().describe('Discover the workflow from Jira again and rewrite the cache, even when one is cached.'),
};

function reachableList(graph: WorkflowGraph, from: string): string[] {
  return findReachableStatuses(graph, from).map(status => {
    const steps = findPath(graph, from, status) ?? [];
    return `- **${status}**: ${steps.map(step => step.name).join(' → ')}`;
  });
}

export const workflowTool = defineTool<JiraToolDeps, typeof workflowShape>({
  name: WORKFLOW_TOOL,
  title: 'Show the statuses a Jira ticket can reach',
  description:
    'Lists the statuses a Jira ticket can be moved to from its current status, each with the transitions that lead there, '
    + "from the workflow of the ticket's project and issue type cached in the workspace. When no workflow is cached yet, "
    + 'it is discovered from Jira by sampling tickets and saved to the cache; refresh: true discovers it again. '
    + 'Changes nothing in Jira; it only writes the local cache file.',
  inputSchema: workflowShape,
  annotations: { readOnlyHint: true },
  handler: async (args, deps) => {
    const key = args.ticketKey.trim();
    if (!key) return 'A ticket key is required, e.g. PROJ-123.';
    if (!isSafePathSegment(key)) return `"${key}" is not a valid ticket key.`;

    return runJiraTool(deps, WORKFLOW_TOOL, `Could not look up the workflow of ${key}`, async ({ access, ticketService }) => {
      const folder = deps.workspaceFolders()[0];
      if (!folder) return 'No workspace folder is open: the workflow is cached in `.jira-workflow-cache.json` in the first workspace folder.';

      const issue = await ticketService.getIssue(key);
      const current = issue.fields.status.name;
      const issueType = (issue.fields.issuetype as { name?: string } | undefined)?.name;
      if (!issueType) return `Jira did not say the issue type of ${key}, so its workflow cannot be looked up.`;
      const projectKey = key.split('-')[0];

      const cached = loadWorkflowCache(folder)[projectKey]?.[issueType];
      let graph: WorkflowGraph;
      let source: string;
      let skippedNote = '';
      if (cached && !args.refresh && cached.graph[current]) {
        graph = cached.graph;
        source = `from the workflow cached on ${cached.discovered}`;
      } else {
        const discovered = await discoverAndCacheWorkflow(access.client, folder, projectKey, issueType);
        if (Object.keys(discovered.graph).length === 0) {
          return `No tickets found for ${projectKey} / ${issueType}, so the workflow could not be sampled.`;
        }
        deps.onDiag?.('info', 'Workflow discovered', { statusCount: Object.keys(discovered.graph).length });
        graph = discovered.graph;
        source = 'from the workflow discovered just now and saved to `.jira-workflow-cache.json`';
        const unknown = discovered.skippedStatuses.filter(s => !discovered.preserved.includes(s));
        if (unknown.length > 0) {
          skippedNote = `\n\n_${unknown.length} status(es) had no tickets to sample, so their transitions are unknown: ${unknown.join(', ')}._`;
        }
      }

      const heading = `**${key}** (${issueType}) is in **${current}**.`;
      const lines = reachableList(graph, current);
      const body = lines.length > 0
        ? `${heading} Statuses it can reach, ${source}:\n\n${lines.join('\n')}`
        : `${heading} No other status can be reached from it, ${source}.`;
      const refreshHint = cached && graph === cached.graph
        ? `\n\nCall ${WORKFLOW_TOOL} again with refresh: true if the workflow has changed since.`
        : '';
      return `${body}${skippedNote}${refreshHint}`;
    });
  },
});
