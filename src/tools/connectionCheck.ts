import type { JiraConfig } from '../services/ConfigService';
import { validateBaseUrl } from '../services/configValidation';
import { tokenStatus } from '../utils/diagUtils';
import type { DiagLogger } from '../utils/diagTypes';
import { buildJiraNotConfiguredMessage } from '../services/setupHints';
import type { JiraAccess } from './jiraTools/jiraAccess';

// The Jira connection check behind both `@jira check` and the check connection tool, so both
// give the same answer from the same code: the base URL is validated first, then Jira is asked
// for the signed-in user. The result carries the facts and the Markdown both surfaces show.

export interface ConnectionSettings {
  baseUrl: string;
  authType: JiraConfig['authType'];
  /** `present (N chars)` or `**absent**`, never the token itself. */
  tokenStatus: string;
}

export type ConnectionCheckResult =
  | { status: 'not-configured'; missing: 'baseUrl' | 'token'; markdown: string }
  | { status: 'invalid-config'; problem: string; markdown: string }
  | { status: 'ok'; settings: ConnectionSettings; userDisplayName: string; markdown: string }
  /** `error` is the full error text; `cause` is what was thrown. */
  | { status: 'failed'; settings: ConnectionSettings; error: string; cause: unknown; markdown: string };

function settingsTable(settings: ConnectionSettings): string {
  return (
    `| Setting | Value |\n` +
    `|---|---|\n` +
    `| Base URL | \`${settings.baseUrl}\` |\n` +
    `| API version | v2 |\n` +
    `| Auth type | ${settings.authType} |\n` +
    `| Token | ${settings.tokenStatus} |\n`
  );
}

/**
 * Checks the connection described by `access`. When Jira is not configured the answer is the
 * plain setup hint naming what is missing (`@jira` shows its own linked version of that hint
 * before it reaches the check). A failed call is reported, and logged through `onDiag`, never thrown;
 * `describeError` words the failure in the Markdown (the full error text by default).
 */
export async function checkConnection(
  access: JiraAccess,
  onDiag?: DiagLogger,
  describeError: (err: unknown) => string = err => (err instanceof Error ? err.message : String(err)),
): Promise<ConnectionCheckResult> {
  if (!access.configured) {
    const { config } = access;
    return { status: 'not-configured', missing: config.baseUrl ? 'token' : 'baseUrl', markdown: buildJiraNotConfiguredMessage(config) };
  }
  const { config } = access;

  const problem = validateBaseUrl(config.baseUrl);
  if (problem) return { status: 'invalid-config', problem, markdown: `**Jira configuration problem**\n\n${problem}` };

  const settings: ConnectionSettings = { baseUrl: config.baseUrl, authType: config.authType, tokenStatus: tokenStatus(config.token) };
  try {
    const user = await access.client.getCurrentUser();
    return {
      status: 'ok',
      settings,
      userDisplayName: user.displayName,
      markdown: `**Jira connection OK**\n\n${settingsTable(settings)}| Logged in as | ${user.displayName} |\n`,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    onDiag?.('error', 'Jira connection check failed', { baseUrl: config.baseUrl, authType: config.authType, error });
    return {
      status: 'failed',
      settings,
      error,
      cause: err,
      markdown: `**Jira connection failed**\n\n${settingsTable(settings)}\nError: ${describeError(err)}`,
    };
  }
}
