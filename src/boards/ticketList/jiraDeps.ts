import type { JiraAccess } from '../../tools/jiraTools/jiraAccess';
import { TicketService } from '../../services/TicketService';
import { discoverAndCacheWorkflow, resolveAndApplyTransition } from '../../services/WorkflowService';
import type { DiagLogger } from '../../utils/diagTypes';
import { describeJiraFailure } from '../../utils/jiraFailureText';
import type { JiraFieldMeta } from '../../jira/IJiraClient';
import { renderFieldValue } from '../../services/TicketService';
import type { ExtraColumn, TicketListDeps, TicketRow } from './kind';

// What the ticket list board needs from Jira, built on the services the Jira tools use: the same
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

/** A field value as the board shows it: plain text, without the markdown emphasis the chat tables use. */
function plainFieldText(value: unknown, meta: JiraFieldMeta | undefined): string {
  if (!meta) return 'Not set';
  return renderFieldValue(value, meta).replace(/^_(.*)_$/, '$1');
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

  // Field names are read once per window and only when an extra column is configured.
  let fieldMeta: Promise<JiraFieldMeta[]> | undefined;
  const metaById = async (): Promise<Map<string, JiraFieldMeta>> => {
    const { ticketService } = await jira();
    fieldMeta ??= ticketService.getFieldMeta().catch(err => { fieldMeta = undefined; throw err; });
    return new Map((await fieldMeta).map(m => [m.id, m]));
  };

  return {
    extraColumns: async () => {
      const access = await options.getJira();
      const search = access.configured ? access.config.searchFields : [];
      const cleanup = access.configured ? access.config.cleanupFields : [];
      if (search.length + cleanup.length === 0) return { search: [], cleanup: [] };
      const meta = await guarded(metaById);
      const column = (setting: string) => (id: string): ExtraColumn => {
        const known = meta.get(id);
        if (!known) options.onDiag?.('warn', `Unrecognized field in ${setting}: ${id}`, { fieldId: id });
        return { id, name: known?.name ?? id };
      };
      return { search: search.map(column('searchFields')), cleanup: cleanup.map(column('cleanupFields')) };
    },

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

    search: (jql, limit, extraFieldIds) => guarded(async () => {
      const { ticketService } = await jira();
      const meta = extraFieldIds.length > 0 ? await metaById() : new Map<string, JiraFieldMeta>();
      const rows: TicketRow[] = [];
      let startAt = 0;
      let token: string | undefined;
      let more = true;
      while (more && rows.length < limit) {
        const page = await ticketService.searchTicketsRaw(jql, Math.min(PAGE_SIZE, limit - rows.length), ['updated', ...extraFieldIds], startAt, token);
        for (const issue of page.issues) {
          rows.push({
            key: issue.key,
            summary: issue.fields.summary ?? '',
            status: issue.fields.status?.name ?? '',
            issueType: issue.fields.issuetype?.name ?? '',
            assignee: textOf(issue.fields.assignee),
            priority: issue.fields.priority?.name ?? '',
            updated: typeof issue.fields.updated === 'string' ? issue.fields.updated : '',
            ...(extraFieldIds.length > 0 ? {
              extra: Object.fromEntries(extraFieldIds.map(id => [id, plainFieldText((issue.fields as Record<string, unknown>)[id], meta.get(id))])),
            } : {}),
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

    // The same update the field tool makes: any field by name or id, a sprint by its name, a list
    // field from comma-separated values, which can also gain or lose single values.
    setField: (key, field, value, operation) => guarded(async () => {
      const { access, ticketService } = await jira();
      const outcome = await ticketService.updateAnyField(key, field, value, operation, access.config.baseUrl);
      if (!outcome.written) throw new Error(outcome.message);
      return outcome.message;
    }),
  };
}
