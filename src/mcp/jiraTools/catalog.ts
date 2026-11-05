import { checkConnection } from '../connectionCheck';
import { defineTool, type McpToolDefinition } from '../mcpServer';
import type { JiraToolDeps } from './jiraAccess';

// Every Jira tool the extension's MCP server offers. The server registers its tools from this
// list, so a tool exists for agents exactly when it is listed here.

export const CHECK_CONNECTION_TOOL = 'jira_check_connection';

const checkConnectionTool = defineTool<JiraToolDeps, Record<string, never>>({
  name: CHECK_CONNECTION_TOOL,
  title: 'Check the Jira connection',
  description:
    'Checks the Jira connection Ticket Sidekick uses. Reports the base URL, the auth type, whether a token is stored '
    + 'and the signed-in Jira user; when the setup is incomplete or wrong, says what is missing or wrong and how to fix it. '
    + 'Takes no input and changes nothing.',
  inputSchema: {},
  annotations: { readOnlyHint: true },
  handler: async (_args, deps) => (await checkConnection(await deps.getJira(), deps.onDiag)).markdown,
});

export const JIRA_TOOLS: readonly McpToolDefinition<JiraToolDeps>[] = [checkConnectionTool];
