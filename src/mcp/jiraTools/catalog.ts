import { checkConnection } from '../connectionCheck';
import { defineTool, ToolFailure, toolErrorLabel, type McpToolDefinition, type McpViewResource } from '../mcpServer';
import type { JiraToolDeps } from './jiraAccess';
import { describeJiraFailure, JiraTimeout, runJiraTool } from './runJiraTool';
import { CHECK_CONNECTION_TOOL } from './toolNames';
import { viewTicketTool } from './viewTicket';
import { findTicketsTool, listMyFiltersTool } from './findTickets';
import { workflowTool } from './workflow';
import { listTemplatesTool } from './templates';
import { loadTicketTool } from './loadTicket';
import { loadPanelView, panelProbeTool } from './loadPanel';
import { moveTicketTool } from './moveTicket';
import { createTicketTool } from './createTicket';
import { addCommentTool } from './addComment';
import { updateFieldTool } from './updateField';
import { uploadAttachmentTool } from './uploadAttachment';

// Every Jira tool the extension's MCP server offers. The server registers its tools from this
// list, so a tool exists for agents exactly when it is listed here.

export * from './toolNames';

const checkConnectionTool = defineTool<JiraToolDeps, Record<string, never>>({
  name: CHECK_CONNECTION_TOOL,
  title: 'Check the Jira connection',
  description:
    'Checks the Jira connection Ticket Sidekick uses. Reports the base URL, the auth type, whether a token is stored '
    + 'and the signed-in Jira user; when the setup is incomplete or wrong, says what is missing or wrong and how to fix it. '
    + 'Takes no input and changes nothing.',
  inputSchema: {},
  annotations: { readOnlyHint: true },
  handler: (_args, deps) =>
    runJiraTool(deps, CHECK_CONNECTION_TOOL, 'Could not check the Jira connection', async ({ access }) => {
      const result = await checkConnection(access, deps.onDiag, describeJiraFailure);
      // A check Jira did not answer in time gets the same timeout answer as every other tool.
      if (result.status === 'failed' && result.cause instanceof JiraTimeout) throw result.cause;
      // A failed check still shows the settings it checked, with only the status of the failure.
      if (result.status === 'failed') throw new ToolFailure(result.markdown, toolErrorLabel(result.cause));
      return result.markdown;
    }),
});

export const JIRA_TOOLS: readonly McpToolDefinition<JiraToolDeps>[] = [
  checkConnectionTool,
  viewTicketTool,
  findTicketsTool,
  listMyFiltersTool,
  workflowTool,
  listTemplatesTool,
  loadTicketTool,
  moveTicketTool,
  createTicketTool,
  addCommentTool,
  updateFieldTool,
  uploadAttachmentTool,
];

/**
 * Tools only the server's inline views may call. The model never sees them, so they are kept out
 * of `JIRA_TOOLS`, which is what agents and the tools page know about.
 */
export const JIRA_APP_TOOLS: readonly McpToolDefinition<JiraToolDeps>[] = [panelProbeTool];

/** The inline views the Jira tools point at. */
export const JIRA_VIEWS: readonly McpViewResource[] = [loadPanelView];
