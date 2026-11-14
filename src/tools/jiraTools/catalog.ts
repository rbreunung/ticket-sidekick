import { checkConnection } from '../connectionCheck';
import { defineTool, ToolFailure, toolErrorLabel, type ToolDefinition } from '../toolDefinition';
import type { JiraToolDeps } from './jiraAccess';
import { describeJiraFailure, JiraTimeout, runJiraTool } from './runJiraTool';
import { CHECK_CONNECTION_TOOL } from './toolNames';
import { viewTicketTool } from './viewTicket';
import { findTicketsTool, listMyFiltersTool } from './findTickets';
import { workflowTool } from './workflow';
import { listTemplatesTool } from './templates';
import { loadTicketTool } from './loadTicket';
import { moveTicketTool } from './moveTicket';
import { createTicketTool } from './createTicket';
import { addCommentTool } from './addComment';
import { updateFieldTool } from './updateField';
import { correctDescriptionTool } from './correctDescription';
import { uploadAttachmentTool } from './uploadAttachment';
import { checkRequiredFieldsTool, listFieldsTool } from './fields';
import { openBoardTool } from './openBoard';

// Every Jira tool the extension offers to Copilot. They are registered with VS Code as language
// model tools from this list, so a tool exists for agents exactly when it is listed here.

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

export const JIRA_TOOLS: readonly ToolDefinition<JiraToolDeps>[] = [
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
  correctDescriptionTool,
  uploadAttachmentTool,
  listFieldsTool,
  checkRequiredFieldsTool,
  openBoardTool,
];
