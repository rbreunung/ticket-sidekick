import { CREATE_TICKET_TOOL, WORKFLOW_TOOL } from './jiraTools/toolNames';

// The Jira Getting-Started walkthrough checks off two of its steps when the tool behind each one
// succeeds: seeing a project's workflow, and creating a first ticket. No `vscode` here; the
// registration sets the context key.

const STEP_DONE_BY_TOOL: Readonly<Record<string, string>> = {
  [WORKFLOW_TOOL]: 'ticketSidekick.workflowViewed',
  [CREATE_TICKET_TOOL]: 'ticketSidekick.firstTicketCreated',
};

/** The walkthrough context key a successful call of this tool sets, if any. */
export function walkthroughStepDoneBy(toolName: string, failed: boolean): string | undefined {
  return failed ? undefined : STEP_DONE_BY_TOOL[toolName];
}
