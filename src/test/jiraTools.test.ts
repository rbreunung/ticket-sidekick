import { describe, it, expect } from 'vitest';
import {
  formatFieldChangeDisplay,
  buildUpdateFieldConfirmation,
  buildAddCommentConfirmation,
  buildCreateTicketConfirmation,
  buildTransitionConfirmation,
  buildLoadTicketConfirmation,
  buildLoadTicketResultMessage,
  formatIssueTypeOptionsMessage,
  formatTemplateListMessage,
  formatWorkflowDiscoveryMessage,
} from '../participant/sessionState';
import { TicketService } from '../services/TicketService';
import { MockJiraClient } from './mocks/MockJiraClient';

// These tests cover the pure builders `src/tools/jiraTools.ts` (vscode-coupled, not
// Vitest-loadable — see CLAUDE.md's Testing section) delegates to for every jira_* Language
// Model tool's confirmation text and result wording (U2).

describe('jira_updateField confirmation (KTD3: current → new)', () => {
  it('shows "Critical → High" given a current and new value', () => {
    expect(formatFieldChangeDisplay('Critical', 'High')).toBe('Critical → High');
  });

  it('names the ticket and field, and shows the change', () => {
    const confirmation = buildUpdateFieldConfirmation('PROJ-123', 'priority', 'Critical', 'High');
    expect(confirmation.title).toContain('PROJ-123');
    expect(confirmation.title).toContain('priority');
    expect(confirmation.message).toContain('PROJ-123');
    expect(confirmation.message).toContain('Critical → High');
  });
});

describe('jira_addComment confirmation', () => {
  it('names the ticket and includes the literal comment text', () => {
    const confirmation = buildAddCommentConfirmation('PROJ-123', 'This looks good to me.');
    expect(confirmation.title).toContain('PROJ-123');
    expect(confirmation.message).toContain('PROJ-123');
    expect(confirmation.message).toContain('This looks good to me.');
  });
});

describe('jira_loadTicket confirmation (R4: names ticket and folder)', () => {
  it('names both the ticket and the target folder, from the ticket key alone', () => {
    const confirmation = buildLoadTicketConfirmation('VSJI-38');
    expect(confirmation.title).toContain('VSJI-38');
    expect(confirmation.message).toContain('VSJI-38');
    expect(confirmation.message).toContain('.jira-context/VSJI-38/');
  });
});

describe('jira_loadTicket result message (R8/KTD4: ask the user, make no assumption)', () => {
  it('names the written files and asks the user before reading them, without instructing the model to read them itself', () => {
    const message = buildLoadTicketResultMessage('VSJI-38', 3, 2, [], []);
    expect(message).toContain('VSJI-38');
    expect(message).toContain('.jira-context/VSJI-38/');
    expect(message).toContain('ticket.md');
    expect(message).toContain('comments.md');
    expect(message).toContain('attachments/');
    expect(message).toMatch(/ask the user/i);
    expect(message).not.toMatch(/read (these|them) (files )?to analyze/i);
  });

  it('omits attachments/ from the file list when nothing was downloaded', () => {
    const message = buildLoadTicketResultMessage('VSJI-38', 0, 0, [], []);
    expect(message).not.toContain('attachments/');
  });

  it('names skipped attachments and points at jira_downloadAttachment to fetch one', () => {
    const skipped = [
      { filename: 'heap-dump.bin', content: 'https://jira.example.com/x', size: 52428800, mimeType: 'application/octet-stream', reason: 'unknown binary format' },
    ];
    const message = buildLoadTicketResultMessage('VSJI-38', 1, 1, skipped, []);
    expect(message).toContain('heap-dump.bin');
    expect(message).toContain('jira_downloadAttachment');
  });

  it('surfaces write errors when present', () => {
    const message = buildLoadTicketResultMessage('VSJI-38', 1, 0, [], ['ticket.md: disk full']);
    expect(message).toContain('ticket.md: disk full');
  });
});

describe('jira_createTicket confirmation (KTD4: names project/type/summary)', () => {
  it('names project, issue type, and summary when the issue type is already resolved', () => {
    const confirmation = buildCreateTicketConfirmation('PROJ', 'Bug', 'Login fails on Safari', null);
    expect(confirmation.message).toContain('PROJ');
    expect(confirmation.message).toContain('Bug');
    expect(confirmation.message).toContain('Login fails on Safari');
  });

  it('names the template when one is supplied', () => {
    const confirmation = buildCreateTicketConfirmation('PROJ', 'Bug', 'Login fails on Safari', 'Bug report');
    expect(confirmation.message).toContain('Bug report');
  });

  it('does not fabricate an issue type when it is not yet resolved', () => {
    const confirmation = buildCreateTicketConfirmation('PROJ', null, 'Login fails on Safari', null);
    expect(confirmation.message).not.toMatch(/\*\*null\*\*/);
    expect(confirmation.message).toContain('to be resolved');
  });

  it('lists the template\'s resolved field values so approval is not blind to what it sets', () => {
    const confirmation = buildCreateTicketConfirmation('PROJ', 'Bug', 'Login fails on Safari', 'Bug report', {
      priority: { name: 'High' },
      labels: ['frontend', 'safari'],
      description: 'This should not appear — shown separately.',
    });
    expect(confirmation.message).toContain('priority');
    expect(confirmation.message).toContain('High');
    expect(confirmation.message).toContain('frontend');
    expect(confirmation.message).toContain('safari');
    expect(confirmation.message).not.toContain('should not appear');
  });

  it('adds no extra note when there are no resolved fields to show', () => {
    const withNull = buildCreateTicketConfirmation('PROJ', 'Bug', 'Login fails on Safari', null, null);
    const withEmpty = buildCreateTicketConfirmation('PROJ', 'Bug', 'Login fails on Safari', null, {});
    expect(withNull.message).not.toContain('will also set');
    expect(withEmpty.message).not.toContain('will also set');
  });
});

describe('jira_transitionTicket confirmation', () => {
  it('names the ticket and the from/to statuses', () => {
    const confirmation = buildTransitionConfirmation('PROJ-123', 'In Progress', 'Done');
    expect(confirmation.message).toContain('PROJ-123');
    expect(confirmation.message).toContain('In Progress');
    expect(confirmation.message).toContain('Done');
  });

  it('includes the resolution when supplied', () => {
    const confirmation = buildTransitionConfirmation('PROJ-123', 'In Progress', 'Done', 'Fixed');
    expect(confirmation.message).toContain('Fixed');
  });

  it('degrades gracefully when the current status could not be fetched', () => {
    const confirmation = buildTransitionConfirmation('PROJ-123', null, 'Done');
    expect(confirmation.message).toContain('its current status');
  });
});

describe('jira_createTicket never-guess fallback (KTD4)', () => {
  it('lists the project\'s valid issue types and creates nothing', () => {
    const message = formatIssueTypeOptionsMessage('PROJ', ['Bug', 'Story', 'Task']);
    expect(message).toContain('No ticket was created');
    expect(message).toContain('Bug');
    expect(message).toContain('Story');
    expect(message).toContain('Task');
  });

  it('still returns an actionable message when the issue-type fetch itself failed', () => {
    const message = formatIssueTypeOptionsMessage('PROJ', []);
    expect(message).toContain('No ticket was created');
    expect(message).toContain('issueType');
  });
});

describe('jira_listTemplates', () => {
  it('returns an empty-list message, not an error, when no templates are configured', () => {
    const message = formatTemplateListMessage([]);
    expect(message).not.toMatch(/error/i);
    expect(message).toContain('No templates found');
  });

  it('lists each template with its issue type', () => {
    const message = formatTemplateListMessage([{ name: 'Bug report', issueType: 'Bug' }, { name: 'Feature', issueType: 'Story' }]);
    expect(message).toContain('Bug report');
    expect(message).toContain('Bug');
    expect(message).toContain('Feature');
    expect(message).toContain('Story');
  });
});

describe('jira_discoverWorkflow result message', () => {
  it('renders each status and its transitions', () => {
    const message = formatWorkflowDiscoveryMessage(
      'PROJ',
      'Bug',
      { 'To Do': [{ id: '1', name: 'Start', to: 'In Progress' }], 'In Progress': [{ id: '2', name: 'Finish', to: 'Done' }] },
      [],
      [],
    );
    expect(message).toContain('To Do');
    expect(message).toContain('In Progress');
    expect(message).toContain('Done');
  });

  it('reports when no tickets were found to sample', () => {
    const message = formatWorkflowDiscoveryMessage('PROJ', 'Bug', {}, [], []);
    expect(message).toContain('No tickets found');
  });

  it('notes a status that kept its cached transitions when it had no representative ticket', () => {
    const message = formatWorkflowDiscoveryMessage(
      'PROJ',
      'Bug',
      { 'To Do': [{ id: '1', name: 'Start', to: 'In Progress' }], 'Done': [{ id: '9', name: 'Reopen', to: 'To Do' }] },
      ['Done'],
      ['Done'],
    );
    expect(message).toContain('kept cached transitions');
    expect(message).toContain('Done');
    expect(message).not.toContain('re-run jira_discoverWorkflow');
  });

  it('warns about a status with no tickets and no cached transitions to fall back on', () => {
    const message = formatWorkflowDiscoveryMessage(
      'PROJ',
      'Bug',
      { 'To Do': [{ id: '1', name: 'Start', to: 'In Progress' }] },
      ['Blocked'],
      [],
    );
    expect(message).toContain('no cached transitions');
    expect(message).toContain('Blocked');
    expect(message).toContain('re-run jira_discoverWorkflow');
  });
});

// jira_getTicket / jira_searchTickets / jira_getComments delegate straight to TicketService
// methods that already have full coverage in TicketService.test.ts — this exercises the exact
// call shape jiraTools.ts's invoke() uses (fieldMeta + baseUrl), confirming the reused path works
// end to end via the shared MockJiraClient fixture.
describe('jira_getTicket (delegates to TicketService.getTicket)', () => {
  it('returns the ticket via the mock client for a valid key', async () => {
    const service = new TicketService(new MockJiraClient());
    const fieldMeta = await service.getFieldMeta();
    const result = await service.getTicket('PROJ-123', fieldMeta, new Set(), new Set());
    expect(result).toContain('PROJ-123');
  });
});
