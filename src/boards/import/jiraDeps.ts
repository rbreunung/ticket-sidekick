import { TicketService } from '../../services/TicketService';
import { buildImportReview, resolveTemplateFields } from '../../imports/review';
import type { JiraAccess } from '../../tools/jiraTools/jiraAccess';
import type { DiagLogger } from '../../utils/diagTypes';
import { describeJiraFailure } from '../../utils/jiraFailureText';
import { fetchAllPages } from '../../utils/reportImport';
import { quoteJqlValue } from '../../utils/searchConstraints';
import { ISSUE_KEY_PATTERN, type ImportDeps, type ImportDescriptors } from './read';

// What the import board needs from Jira, built on the shared services: template resolution, the
// review build (dedup, descriptions, stale search) and the reads the export needs. Failures are worded as status and short reason; Jira's response body never reaches
// the page.

const KEY_CHUNK = 50;
const UPDATED_PARALLEL = 4;
/** How many candidate tickets one subject search reads; the exact compare happens afterwards. */
const SUMMARY_RESULTS = 100;

export interface ImportJiraOptions {
  getJira(): Promise<JiraAccess>;
  /** The first workspace folder: templates, the workflow cache and the accepted list live there. */
  workspaceFolder(): string | undefined;
  descriptors: ImportDescriptors | (() => ImportDescriptors);
  now(): number;
  csvDelimiter?(): string;
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
    writeAccess: async () => {
      const { ticketService, client } = await jira();
      return { ticketService, client };
    },
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
      const readChunk = (chunk: string[]) => fetchAllPages(
        (startAt, pageToken) => ticketService.searchTicketsRaw(`key in (${chunk.join(', ')}) ORDER BY key ASC`, KEY_CHUNK, ['updated'], startAt, pageToken),
        KEY_CHUNK, KEY_CHUNK, issue => issue.key,
      );
      await guarded('Reading the tickets\' update times', async () => {
        // Up to UPDATED_PARALLEL chunks at once; results merge and a failure surfaces in chunk order, as one at a time would.
        for (let i = 0; i < valid.length; i += KEY_CHUNK * UPDATED_PARALLEL) {
          const chunks: string[][] = [];
          for (let j = i; j < Math.min(valid.length, i + KEY_CHUNK * UPDATED_PARALLEL); j += KEY_CHUNK) chunks.push(valid.slice(j, j + KEY_CHUNK));
          const settled = await Promise.allSettled(chunks.map(readChunk));
          for (const outcome of settled) {
            if (outcome.status === 'rejected') throw outcome.reason;
            for (const issue of outcome.value) {
              const updated = (issue.fields as { updated?: unknown }).updated;
              if (typeof updated === 'string') times[issue.key] = updated;
            }
          }
        }
      });
      return times;
    },

    projectVersions: async projectKey => {
      const { ticketService } = await jira();
      return guarded('Reading the project versions', () => ticketService.getProjectVersions(projectKey));
    },

    summarySearch: async (projectKey, terms) => {
      const { ticketService } = await jira();
      const jql = `project = ${quoteJqlValue(projectKey)} AND (${terms.map(t => `summary ~ ${quoteJqlValue(t)}`).join(' OR ')}) ORDER BY created DESC`;
      return guarded('Searching for tickets with the same subject', async () => {
        const result = await ticketService.searchTicketsRaw(jql, SUMMARY_RESULTS, ['summary']);
        return result.issues.map(issue => ({ key: issue.key, summary: String((issue.fields as { summary?: unknown }).summary ?? '') }));
      });
    },

    descriptions: async keys => {
      const { ticketService } = await jira();
      const { texts } = await ticketService.readDescriptions(keys, (key, err) => options.onDiag?.('warn', `Import board: could not read the description of ${key}`, {
        issueKey: key, error: err instanceof Error ? err.message : String(err),
      }));
      return texts;
    },

    now: options.now,
    ...(options.csvDelimiter ? { csvDelimiter: options.csvDelimiter } : {}),
    onDiag: options.onDiag,
  };
}
