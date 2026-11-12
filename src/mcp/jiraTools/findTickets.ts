import { z } from 'zod';
import type { JiraFilter } from '../../jira/IJiraClient';
import type { TicketService } from '../../services/TicketService';
import {
  buildConstraintClauses,
  buildConstraintJql,
  buildTeamJql,
  formatBulletList,
  formatFilterCandidateList,
  formatMyFiltersList,
  resolveNamedConstraints,
  type PendingSearchConstraints,
} from '../../participant/sessionState';
import { defineTool } from '../mcpServer';
import type { JiraToolDeps } from './jiraAccess';
import { runJiraTool } from './runJiraTool';
import { FIND_TICKETS_TOOL, LIST_MY_FILTERS_TOOL } from './toolNames';

// One search tool over JQL or a saved filter, narrowed the way `@jira` narrows a filter (fix
// version, sprint, assignee and the team JQL), plus the list of the user's own filters.

export const FIND_PAGE_SIZE = 50;

const NO_TEAM_JQL =
  'No team JQL configured. Set `ticketSidekick.jira.myTeamJql` in your VS Code settings (e.g. `project = BACKEND AND assignee in membersOf("backend-team")`).';

/**
 * Splits a trailing `ORDER BY` off a query, so narrowing clauses can be ANDed onto the condition
 * while the saved ordering stays at the end, where JQL requires it. A query that only sorts has
 * an empty condition.
 */
export function splitOrderBy(jql: string): { where: string; orderBy: string } {
  // Scanned so that words inside a quoted value, such as summary ~ "slow ORDER BY query", are
  // never taken for the sort clause; a backslash escapes the next character inside quotes.
  let quote: string | undefined;
  for (let i = 0; i < jql.length; i++) {
    const ch = jql[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if ((i === 0 || /[\s)]/.test(jql[i - 1])) && /^ORDER\s+BY\s/i.test(jql.slice(i))) {
      return { where: jql.slice(0, i).trim(), orderBy: jql.slice(i).trim() };
    }
  }
  return { where: jql, orderBy: '' };
}

async function resolveFilter(filter: string, ticketService: TicketService): Promise<JiraFilter | string> {
  if (/^\d+$/.test(filter)) return ticketService.getFilterById(filter);
  const filters = await ticketService.searchFiltersByName(filter);
  if (filters.length === 0) return `No saved filters found matching "${filter}". Call ${LIST_MY_FILTERS_TOOL} to see your saved filters.`;
  if (filters.length > 1) {
    return `Multiple filters match "${filter}":\n\n${formatFilterCandidateList(filters)}\n\nCall ${FIND_TICKETS_TOOL} again with one filter's id as filter.`;
  }
  return filters[0];
}

const findShape = {
  jql: z.string().optional().describe('A JQL query. Give either jql or filter.'),
  filter: z.string().optional().describe('A saved filter, by its id or its name. Give either jql or filter.'),
  fixVersion: z.string().optional().describe('Narrow to a fix version, by name; resolved in the single project the query scopes to.'),
  sprint: z.string().optional().describe('Narrow to a sprint, by name; resolved in the single project the query scopes to.'),
  assignee: z.string().optional().describe('Narrow to an assignee: a user name, or "me" for the signed-in user.'),
  myTeam: z.boolean().optional().describe('Narrow by the team JQL from the ticketSidekick.jira.myTeamJql setting ("my team").'),
  page: z.string().optional().describe('The page value a previous answer gave, to read the next page of the same query.'),
};

export const findTicketsTool = defineTool<JiraToolDeps, typeof findShape>({
  name: FIND_TICKETS_TOOL,
  title: 'Find Jira tickets',
  description:
    'Finds Jira tickets by JQL or by a saved filter (id or name); give exactly one of jql and filter. '
    + 'Use it for your own lookups and to answer a question about tickets. When the user asks to see a list of tickets, or to change more than one ticket, '
    + 'open the ticket-list canvas instead and do not list the tickets in chat. '
    + `When the request matches one of the user's saved filters (see ${LIST_MY_FILTERS_TOOL}), use that filter rather than writing new JQL. `
    + '"My team" means the team JQL in the ticketSidekick.jira.myTeamJql setting: set myTeam to true to narrow by it instead of guessing who is on the team. '
    + 'Narrow further with fixVersion, sprint and assignee ("me" for the signed-in user). '
    + `Shows ${FIND_PAGE_SIZE} tickets per page with the columns from the ticketSidekick.jira.searchFields setting; when more tickets match, `
    + 'the answer gives the page value for the next call. Changes nothing.',
  inputSchema: findShape,
  annotations: { readOnlyHint: true },
  handler: async (args, deps) => {
    const jql = args.jql?.trim() || undefined;
    const filter = args.filter?.trim() || undefined;
    if (jql && filter) return 'Give either jql or filter, not both. To narrow a saved filter, use fixVersion, sprint, assignee or myTeam.';
    if (!jql && !filter) return `Give either jql or filter. Call ${LIST_MY_FILTERS_TOOL} to see your saved filters.`;
    const page = args.page?.trim() || undefined;

    return runJiraTool(deps, FIND_TICKETS_TOOL, 'Search failed', async ({ access, config, ticketService }) => {
      const cloud = config.authType === 'cloud';
      if (page && !cloud && !/^\d+$/.test(page)) return `"${page}" is not a page value from an earlier ${FIND_TICKETS_TOOL} answer.`;

      let base = jql ?? '';
      let label = '';
      if (filter) {
        const resolved = await resolveFilter(filter, ticketService);
        if (typeof resolved === 'string') return resolved;
        base = resolved.jql;
        label = `_Using filter: **${resolved.name}**_\n\n`;
      }

      const { where, orderBy } = splitOrderBy(base);
      let narrowed = where;
      if (args.myTeam) {
        if (!config.myTeamJql) return NO_TEAM_JQL;
        // Without a condition of its own (a query that only sorts), the team JQL is the condition.
        narrowed = narrowed ? buildTeamJql(config.myTeamJql, narrowed) : config.myTeamJql;
        label += '_Narrowed by the team JQL_\n\n';
      }

      const named: PendingSearchConstraints = {
        fixVersion: args.fixVersion?.trim() || undefined,
        sprint: args.sprint?.trim() || undefined,
        assignee: args.assignee?.trim() || undefined,
      };
      if (named.fixVersion || named.sprint || named.assignee) {
        const resolution = await resolveNamedConstraints(narrowed, named, access.client);
        switch (resolution.kind) {
          case 'noProjectScope':
          case 'notFound':
            return resolution.message;
          case 'ambiguous': {
            const kindLabel = resolution.constraintKind === 'fixVersion' ? 'fix version' : resolution.constraintKind;
            const list = formatBulletList(resolution.options.map(o => o.label));
            return `Multiple ${kindLabel} matches:\n\n${list}\n\nCall ${FIND_TICKETS_TOOL} again with a more exact ${kindLabel} value.`;
          }
          case 'resolved':
            narrowed = narrowed
              ? buildConstraintJql(narrowed, resolution.constraints)
              : buildConstraintClauses(resolution.constraints).join(' AND ');
            break;
        }
      }
      const finalJql = [narrowed, orderBy].filter(part => part.length > 0).join(' ');

      const startAt = page && !cloud ? Number(page) : undefined;
      const pageToken = page && cloud ? page : undefined;
      const result = await ticketService.searchTicketsRaw(finalJql, FIND_PAGE_SIZE, config.searchFields, startAt, pageToken);
      const fieldMeta = config.searchFields.length > 0 ? await ticketService.getFieldMeta() : [];
      const table = ticketService.formatSearchResults(result, finalJql, config.baseUrl, config.searchFields, fieldMeta, { chatActions: false });

      let next: string | undefined;
      if (cloud) {
        if (result.nextPageToken && result.isLast !== true) next = result.nextPageToken;
      } else {
        const read = (startAt ?? 0) + result.issues.length;
        if (result.issues.length > 0 && result.total !== undefined && read < result.total) next = String(read);
      }
      const pageNote = next ? `\n\nMore tickets match: call ${FIND_TICKETS_TOOL} again with the same query and page "${next}".` : '';
      return `${label}${table}${pageNote}`;
    });
  },
});

export const listMyFiltersTool = defineTool<JiraToolDeps, Record<string, never>>({
  name: LIST_MY_FILTERS_TOOL,
  title: 'List my Jira filters',
  description:
    "Lists the user's saved Jira filters, favourites and owned ones, each once, with name and id. "
    + `Pass a filter's id or name to ${FIND_TICKETS_TOOL} to run it. Takes no input and changes nothing.`,
  inputSchema: {},
  annotations: { readOnlyHint: true },
  handler: (_args, deps) =>
    runJiraTool(deps, LIST_MY_FILTERS_TOOL, 'Could not list your filters', async ({ ticketService }) => {
      const { filters, failedSources } = await ticketService.getMyFilters();
      return formatMyFiltersList(filters, failedSources);
    }),
});
