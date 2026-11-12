import type { JiraAccess } from '../../mcp/jiraTools/jiraAccess';
import { supportedFieldId, TicketService } from '../../services/TicketService';
import { discoverAndCacheWorkflow, resolveAndApplyTransition } from '../../services/WorkflowService';
import type { DiagLogger } from '../../utils/diagTypes';
import { describeJiraFailure } from '../../utils/jiraFailureText';
import type { TicketListDeps, TicketRow } from './kind';

// What the ticket list board needs from Jira, built on the services the MCP tools use: the same
// search, the same move (direct, along the cached workflow, or after discovering it once) and the
// same field update. Failures are worded as status and short reason; Jira's response body never
// reaches the page.

const PAGE_SIZE = 100;

export interface TicketListJiraOptions {
  getJira(): Promise<JiraAccess>;
  /** The first workspace folder, where the workflow cache lives. */
  workspaceFolder(): string | undefined;
  now(): number;
  onDiag?: DiagLogger;
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  const v = value as { displayName?: unknown; name?: unknown } | null;
  return typeof v?.displayName === 'string' ? v.displayName : typeof v?.name === 'string' ? v.name : '';
}

export function ticketListJiraDeps(options: TicketListJiraOptions): TicketListDeps {
  const jira = async () => {
    const access = await options.getJira();
    if (!access.configured) throw new Error('Jira is not set up in this window.');
    return { access, client: access.client, ticketService: new TicketService(access.client, options.onDiag) };
  };
  /** Runs a Jira call and words its failure without the response body. */
  const guarded = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (err) {
      options.onDiag?.('warn', 'Ticket list: Jira call failed', { error: err instanceof Error ? err.message : String(err) });
      throw new Error(describeJiraFailure(err));
    }
  };

  return {
    jiraConfigured: async () => (await options.getJira()).configured,
    baseUrl: async () => {
      const access = await options.getJira();
      return access.configured ? access.config.baseUrl : undefined;
    },
    now: options.now,

    resolveFilter: async filter => {
      try {
        const { ticketService } = await jira();
        if (/^\d+$/.test(filter)) {
          const found = await ticketService.getFilterById(filter);
          return { id: String(found.id), name: found.name, jql: found.jql };
        }
        const matches = await ticketService.searchFiltersByName(filter);
        if (matches.length === 0) return `no saved filter matches "${filter}".`;
        if (matches.length > 1) return `several saved filters match "${filter}": ${matches.slice(0, 8).map(f => `${f.name} (id ${f.id})`).join(', ')}. Ask again with one filter's id.`;
        return { id: String(matches[0].id), name: matches[0].name, jql: matches[0].jql };
      } catch (err) {
        return `the saved filter could not be read: ${describeJiraFailure(err)}`;
      }
    },

    search: (jql, limit) => guarded(async () => {
      const { ticketService } = await jira();
      const rows: TicketRow[] = [];
      let startAt = 0;
      let token: string | undefined;
      let more = true;
      while (more && rows.length < limit) {
        const page = await ticketService.searchTicketsRaw(jql, Math.min(PAGE_SIZE, limit - rows.length), ['updated'], startAt, token);
        for (const issue of page.issues) {
          rows.push({
            key: issue.key,
            summary: issue.fields.summary ?? '',
            status: issue.fields.status?.name ?? '',
            issueType: issue.fields.issuetype?.name ?? '',
            assignee: textOf(issue.fields.assignee),
            priority: issue.fields.priority?.name ?? '',
            updated: typeof issue.fields.updated === 'string' ? issue.fields.updated : '',
          });
        }
        startAt += page.issues.length;
        token = page.nextPageToken;
        const total = page.total;
        more = page.issues.length > 0 && page.isLast !== true && (token !== undefined || total === undefined || startAt < total);
      }
      return { rows, truncated: more };
    }),

    readTicket: async key => {
      const { client } = await jira();
      try {
        const issue = await client.getIssue(key);
        return { status: issue.fields.status.name, updated: typeof issue.fields.updated === 'string' ? issue.fields.updated : '' };
      } catch (err) {
        if ((err as { status?: unknown } | null)?.status === 404) return undefined;
        throw new Error(describeJiraFailure(err));
      }
    },

    move: (key, status, resolution) => guarded(async () => {
      const { client, ticketService } = await jira();
      const folder = options.workspaceFolder();
      const attempt = () => resolveAndApplyTransition(client, ticketService, folder ?? '', key, status, resolution);
      let result = await attempt();
      // No direct transition and no cached path: discover the workflow once, then try again.
      if (result.kind === 'unavailable' && folder && result.issueType) {
        const discovery = await discoverAndCacheWorkflow(client, folder, result.projectKey, result.issueType);
        if (Object.keys(discovery.graph).length > 0) result = await attempt();
      }
      switch (result.kind) {
        case 'alreadyThere': return `already in ${result.currentStatus}`;
        case 'direct':
        case 'multiHop': return `moved to ${result.toStatus}`;
        case 'partialFailure':
          throw new Error(`stopped partway: last confirmed in ${result.landedStatus} after ${result.completedHops} of ${result.totalHops} steps. ${result.error}`);
        case 'unavailable': {
          const reach = result.available.length > 0 ? ` It can reach: ${result.available.join(', ')}.` : '';
          throw new Error(`no path from ${result.currentStatus} to ${status}.${reach}`);
        }
      }
    }),

    setField: (key, field, value) => guarded(async () => {
      const { access, client, ticketService } = await jira();
      if (supportedFieldId(field)) {
        const outcome = await ticketService.updateFieldOutcome(key, field, value, access.config.baseUrl);
        if (!outcome.written) throw new Error(outcome.message);
        return outcome.message;
      }
      // Any other field, by display name or id, with the value shaped as that field needs it.
      const fieldId = await ticketService.resolveFieldId(field);
      await client.updateIssue(key, { [fieldId]: await ticketService.buildFieldValue(fieldId, key, value) });
      return `set ${field}`;
    }),
  };
}
