import { TicketService } from '../../services/TicketService';
import { buildImportReview, resolveTemplateFields } from '../../imports/review';
import type { JiraAccess } from '../../tools/jiraTools/jiraAccess';
import type { DiagLogger } from '../../utils/diagTypes';
import { describeJiraFailure } from '../../utils/jiraFailureText';
import { fetchAllPages } from '../../utils/reportImport';
import type { ImportDeps, ImportDescriptors } from './read';

// What the import board needs from Jira, built on the services the chat import uses: the same
// template resolution, the same review build (dedup, descriptions, stale search) and the reads the
// export needs. Failures are worded as status and short reason; Jira's response body never reaches
// the page.

const KEY_CHUNK = 50;
const ISSUE_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;

export interface ImportJiraOptions {
  getJira(): Promise<JiraAccess>;
  /** The first workspace folder: templates, the workflow cache and the accepted list live there. */
  workspaceFolder(): string | undefined;
  descriptors: ImportDescriptors | (() => ImportDescriptors);
  now(): number;
  onDiag?: DiagLogger;
}

export function importJiraDeps(options: ImportJiraOptions): ImportDeps {
  const jira = async () => {
    const access = await options.getJira();
    if (!access.configured) throw new Error('Jira is not set up in this window.');
    return { access, client: access.client, ticketService: new TicketService(access.client, options.onDiag) };
  };
  /** Runs a Jira call and words its failure without the response body. */
  const guarded = async <T>(what: string, work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (err) {
      options.onDiag?.('warn', `Import board: ${what} failed`, { error: err instanceof Error ? err.message : String(err) });
      throw new Error(`${what} failed: ${describeJiraFailure(err)}`);
    }
  };
  const workspaceRoot = () => options.workspaceFolder() ?? '';

  return {
    jiraConfigured: async () => (await options.getJira()).configured,
    descriptors: () => (typeof options.descriptors === 'function' ? options.descriptors() : options.descriptors),
    baseUrl: async () => {
      const access = await options.getJira();
      return access.configured ? access.config.baseUrl : undefined;
    },
    workspaceRoot: options.workspaceFolder,

    templateFields: async (recipe, descriptor) => {
      const { client } = await jira();
      const resolved = await resolveTemplateFields(recipe.templateName, recipe.projectKey, client, descriptor, workspaceRoot(), options.onDiag);
      if (!resolved.problem) return { additionalFields: resolved.additionalFields };
      const problem = resolved.problem.kind === 'missing'
        ? `The template "${recipe.templateName}" is no longer in .jira-templates.json, so new tickets get no template fields. Start over to pick another.`
        : `The fields of the template "${recipe.templateName}" could not be resolved, so new tickets get no template fields: ${describeJiraFailure(resolved.problem.error)}`;
      return { additionalFields: resolved.additionalFields, problem };
    },

    buildReview: async (input, descriptor, onEvent) => {
      const { client, ticketService } = await jira();
      return guarded('Reading the review', async () => {
        const built = await buildImportReview(input, { getResolutions: () => client.getResolutions() }, ticketService, descriptor, {
          workspaceRoot: workspaceRoot(), onDiag: options.onDiag, onEvent,
        });
        return { session: built.session, dedupFailed: built.dedupFailed };
      });
    },

    overviewTickets: async (keys, source) => {
      const { ticketService } = await jira();
      return guarded('Reading the matched tickets', () => ticketService.getOverviewTicketsByKeys(keys, source));
    },

    updatedTimes: async keys => {
      const { ticketService } = await jira();
      const valid = [...new Set(keys)].filter(k => ISSUE_KEY_PATTERN.test(k));
      const times: Record<string, string> = {};
      await guarded('Reading the tickets\' update times', async () => {
        for (let i = 0; i < valid.length; i += KEY_CHUNK) {
          const chunk = valid.slice(i, i + KEY_CHUNK);
          const issues = await fetchAllPages(
            (startAt, pageToken) => ticketService.searchTicketsRaw(`key in (${chunk.join(', ')}) ORDER BY key ASC`, KEY_CHUNK, ['updated'], startAt, pageToken),
            KEY_CHUNK, KEY_CHUNK, issue => issue.key,
          );
          for (const issue of issues) {
            const updated = (issue.fields as { updated?: unknown }).updated;
            if (typeof updated === 'string') times[issue.key] = updated;
          }
        }
      });
      return times;
    },

    projectVersions: async projectKey => {
      const { ticketService } = await jira();
      return guarded('Reading the project versions', () => ticketService.getProjectVersions(projectKey));
    },

    descriptions: async keys => {
      const { ticketService } = await jira();
      const { texts } = await ticketService.readDescriptions(keys, (key, err) => options.onDiag?.('warn', `Import board: could not read the description of ${key}`, {
        issueKey: key, error: err instanceof Error ? err.message : String(err),
      }));
      return texts;
    },

    now: options.now,
    onDiag: options.onDiag,
  };
}
