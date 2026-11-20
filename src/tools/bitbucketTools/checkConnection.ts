import type { BitbucketConfig } from '../../bitbucket/IBitbucketClient';
import { validateBaseUrl } from '../../services/configValidation';
import { buildBitbucketNotConfiguredMessage } from '../../services/setupHints';
import { tokenStatus } from '../../utils/diagUtils';
import { defineTool, ToolFailure, toolErrorLabel } from '../toolDefinition';
import type { BitbucketToolDeps } from './bitbucketAccess';
import { CHECK_CONNECTION_TOOL } from './toolNames';

// The Bitbucket connection check: for Data Center the base URL is validated first, then Bitbucket
// is asked for the signed-in user (Cloud talks to api.bitbucket.org and ignores the base URL).

function settingsTable(config: BitbucketConfig): string {
  const cloud = config.authType === 'cloud';
  return (
    `| Setting | Value |\n|---|---|\n` +
    `| Base URL | \`${cloud ? 'https://api.bitbucket.org' : config.baseUrl ?? ''}\` |\n` +
    `| API version | ${cloud ? 'v2.0' : 'v1.0'} |\n` +
    `| Auth type | ${config.authType} |\n` +
    `| Token | ${tokenStatus(config.token)} |\n`
  );
}

export const checkConnectionTool = defineTool<BitbucketToolDeps, Record<string, never>>({
  name: CHECK_CONNECTION_TOOL,
  title: 'Check the Bitbucket connection',
  description:
    'Checks the Bitbucket connection Ticket Sidekick uses. Reports the base URL, the API version, the auth type, whether a token is stored '
    + 'and the signed-in Bitbucket user; when the setup is incomplete or wrong, says what is missing or wrong and how to fix it. '
    + 'Takes no input and changes nothing.',
  inputSchema: {},
  annotations: { readOnlyHint: true },
  handler: async (_args, deps) => {
    const access = await deps.getBitbucket();
    const { config } = access;
    if (!access.configured) {
      const baseUrl = config.authType === 'cloud' ? 'n/a (Cloud)' : config.baseUrl ? 'present' : '**absent**';
      return (
        '**Bitbucket not configured.**\n\n' +
        `| Setting | Status |\n|---|---|\n| Auth type | ${config.authType} |\n| Base URL | ${baseUrl} |\n| Token | ${tokenStatus(config.token)} |\n\n` +
        buildBitbucketNotConfiguredMessage(config)
      );
    }
    if (config.authType === 'datacenter') {
      const problem = validateBaseUrl(config.baseUrl);
      if (problem) return `**Bitbucket configuration problem**\n\n${problem}`;
    }
    try {
      const user = await access.client.getCurrentUser();
      return `**Bitbucket connection OK**\n\n${settingsTable(config)}| Logged in as | ${user.displayName} |\n`;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.onDiag?.('error', 'Bitbucket connection check failed', { baseUrl: config.baseUrl, authType: config.authType, error: message });
      throw new ToolFailure(`**Bitbucket connection failed**\n\n${settingsTable(config)}\nError: ${message}`, toolErrorLabel(err));
    }
  },
});
