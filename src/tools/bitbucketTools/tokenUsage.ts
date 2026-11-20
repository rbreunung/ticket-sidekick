import { formatUsageTable } from '../../utils/tokenUsage';
import { defineTool } from '../toolDefinition';
import type { BitbucketToolDeps } from './bitbucketAccess';
import { TOKEN_USAGE_TOOL } from './toolNames';

export const tokenUsageTool = defineTool<BitbucketToolDeps, Record<string, never>>({
  name: TOKEN_USAGE_TOOL,
  title: 'Show the review token usage',
  description:
    'Shows the language model tokens the pull request reviews used, per month and model, for the current month and the two before it. '
    + 'The counts are kept on this computer. Takes no input and changes nothing.',
  inputSchema: {},
  annotations: { readOnlyHint: true },
  // The counts live on this computer, so the table is shown whether or not Bitbucket is configured.
  handler: async (_args, deps) => formatUsageTable(deps.tokenUsage(), deps.now()),
});
