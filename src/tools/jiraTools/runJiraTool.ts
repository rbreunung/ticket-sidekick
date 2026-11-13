import type { IJiraClient } from '../../jira/IJiraClient';
import { TicketService } from '../../services/TicketService';
import { buildJiraNotConfiguredMessage } from '../../services/setupHints';
import { ToolFailure, toolErrorLabel } from '../toolDefinition';
import type { ConfiguredJiraConfig, JiraAccess, JiraToolDeps } from './jiraAccess';
import { describeJiraFailure, rootCause } from '../../utils/jiraFailureText';
import { CHECK_CONNECTION_TOOL, VIEW_TICKET_TOOL } from './toolNames';

// The one place where a Jira tool's failures become answers for the agent. Every Jira tool runs
// its Jira work through `runJiraTool`: without a configured Jira the agent gets the setup hint;
// every request to Jira has its own time limit, and a read that takes too long ends the tool
// with a timeout answer (an attachment download that takes too long fails on its own, and the
// load reports that attachment as not downloaded; a write that takes too long is answered with
// a warning that the change may still have been saved); a failed call is answered with its HTTP
// status and a short reason only, never with Jira's or a proxy's response body, while the full
// error text goes to the Output channel for diagnosis.

/** How long one Jira request may take, unless the tool's deps set another limit. */
export const JIRA_REQUEST_TIMEOUT_MS = 30_000;
/** How long one attachment download may take, unless the tool's deps set another limit. */
export const JIRA_DOWNLOAD_TIMEOUT_MS = 120_000;
export { describeJiraFailure, MAX_FAILURE_REASON_CHARS } from '../../utils/jiraFailureText';

export interface ConfiguredJira {
  access: Extract<JiraAccess, { configured: true }>;
  config: ConfiguredJiraConfig;
  ticketService: TicketService;
}

export function formatSeconds(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  return `${seconds} second${seconds === 1 ? '' : 's'}`;
}

/** The Jira client calls that change something in Jira. */
export const WRITE_REQUESTS: ReadonlySet<string> = new Set([
  'updateIssue', 'addComment', 'createIssue', 'createIssueLink', 'executeTransition', 'uploadAttachment',
]);

/**
 * How a failed call is labelled when a write timed out: Jira may still have made the change, so a
 * write tool keeps its duplicate guard for that call instead of releasing it.
 */
export const WRITE_TIMEOUT_LABEL = 'write-timeout';

/** A Jira request that did not finish within its time limit. */
export class JiraTimeout extends Error {
  constructor(readonly request: string, readonly timeoutMs: number) {
    super(`Jira did not respond to ${request} within ${formatSeconds(timeoutMs)}`);
    this.name = 'JiraTimeout';
  }
}

function withTimeout<T>(pending: PromiseLike<T>, request: string, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new JiraTimeout(request, timeoutMs)), timeoutMs);
  });
  return Promise.race([pending, timedOut]).finally(() => clearTimeout(timer));
}

/**
 * `client` with a time limit on each of its calls: `downloadTimeoutMs` for an attachment
 * download, `requestTimeoutMs` for every other call. A call over its limit rejects with a
 * {@link JiraTimeout}; the request itself is not cancelled, and what it returns later is dropped.
 */
export function withRequestTimeouts(client: IJiraClient, requestTimeoutMs: number, downloadTimeoutMs: number): IJiraClient {
  return new Proxy(client, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      const timeoutMs = property === 'downloadAttachment' ? downloadTimeoutMs : requestTimeoutMs;
      return (...args: unknown[]) => {
        const result: unknown = value.apply(target, args);
        return typeof (result as PromiseLike<unknown> | null)?.then === 'function'
          ? withTimeout(result as PromiseLike<unknown>, String(property), timeoutMs)
          : result;
      };
    },
  });
}

/**
 * Runs a tool's Jira work. `failurePrefix` starts the answer to a failure (for example
 * `Could not read PROJ-123`); pass a function when the work itself decides what it names.
 * A `ToolFailure` the work throws is passed on as it is.
 */
export async function runJiraTool(
  deps: JiraToolDeps,
  tool: string,
  failurePrefix: string | (() => string),
  work: (jira: ConfiguredJira) => Promise<string>,
): Promise<string> {
  const access = await deps.getJira();
  if (!access.configured) return buildJiraNotConfiguredMessage(access.config);

  const client = withRequestTimeouts(
    access.client,
    deps.jiraTimeoutMs ?? JIRA_REQUEST_TIMEOUT_MS,
    deps.jiraDownloadTimeoutMs ?? JIRA_DOWNLOAD_TIMEOUT_MS,
  );
  const jira: ConfiguredJira = {
    access: { ...access, client },
    config: access.config,
    ticketService: new TicketService(client, deps.onDiag),
  };
  const prefix = () => (typeof failurePrefix === 'function' ? failurePrefix() : failurePrefix);
  try {
    return await work(jira);
  } catch (err) {
    if (err instanceof ToolFailure) throw err;
    // A move that failed on its first step wraps the real error; classify that one.
    const cause = rootCause(err);
    if (cause instanceof JiraTimeout) {
      deps.onDiag?.('error', `${tool}: Jira did not respond to ${cause.request} within ${cause.timeoutMs} ms`, {
        error: err instanceof Error ? err.message : String(err),
      });
      if (WRITE_REQUESTS.has(cause.request)) {
        // The request was sent and not cancelled, so Jira may still have made the change.
        throw new ToolFailure(
          `${prefix()}: Jira did not answer within ${formatSeconds(cause.timeoutMs)}. The change may still have been saved: `
          + `view the ticket with ${VIEW_TICKET_TOOL} before trying again.`,
          WRITE_TIMEOUT_LABEL,
        );
      }
      throw new ToolFailure(
        `${prefix()}: Jira did not respond within ${formatSeconds(cause.timeoutMs)}. Try again later, or check the connection with ${CHECK_CONNECTION_TOOL}.`,
        'timeout',
      );
    }
    const status = (cause as { status?: unknown } | null)?.status;
    deps.onDiag?.('error', `${tool} failed`, {
      ...(typeof status === 'number' ? { status } : {}),
      error: err instanceof Error ? err.message : String(err),
    });
    throw new ToolFailure(`${prefix()}: ${describeJiraFailure(cause)}`, toolErrorLabel(cause));
  }
}
