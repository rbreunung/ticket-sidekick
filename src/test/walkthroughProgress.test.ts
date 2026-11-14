import { describe, it, expect } from 'vitest';
import { walkthroughStepDoneBy } from '../tools/walkthroughProgress';
import { CREATE_TICKET_TOOL, VIEW_TICKET_TOOL, WORKFLOW_TOOL } from '../tools/jiraTools/toolNames';

// The Getting-Started walkthrough's workflow and first-ticket steps are checked off by the tools.

describe('walkthrough steps checked off by the Jira tools', () => {
  it('checks off the workflow step after the workflow tool and the first-ticket step after a create', () => {
    expect(walkthroughStepDoneBy(WORKFLOW_TOOL, false)).toBe('ticketSidekick.workflowViewed');
    expect(walkthroughStepDoneBy(CREATE_TICKET_TOOL, false)).toBe('ticketSidekick.firstTicketCreated');
  });

  it('checks off nothing for a failed call or another tool', () => {
    expect(walkthroughStepDoneBy(CREATE_TICKET_TOOL, true)).toBeUndefined();
    expect(walkthroughStepDoneBy(VIEW_TICKET_TOOL, false)).toBeUndefined();
  });
});
