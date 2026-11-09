import { describe, it, expect } from 'vitest';
import {
  formatFieldChangeDisplay,
  buildUpdateFieldConfirmation,
  buildAddCommentConfirmation,
  buildCreateTicketConfirmation,
  buildTransitionConfirmation,
  buildUploadAttachmentConfirmation,
  formatIssueTypeOptionsMessage,
} from '../participant/sessionState';
import { JIRA_TOOLS, LIST_TEMPLATES_TOOL } from '../mcp/jiraTools/catalog';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// These tests cover the pure builders `src/tools/jiraTools.ts` (vscode-coupled, not
// Vitest-loadable — see CLAUDE.md's Testing section) delegates to for the Jira Agent Mode write
// tools' confirmation text and result wording, and what package.json declares for them.

const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf-8'));
const declaredTools: Array<{ name: string } & Record<string, any>> = pkg.contributes.languageModelTools;

describe('Jira Agent Mode tools next to the MCP server', () => {
  it('declares only the Jira tools that write; the read tools are served by the MCP server', () => {
    const jiraTools = declaredTools.map(t => t.name).filter(name => name.startsWith('jira_')).sort();
    expect(jiraTools).toEqual(['jira_addComment', 'jira_createTicket', 'jira_transitionTicket', 'jira_updateField', 'jira_uploadAttachment']);
  });

  it('points the model only at tools that exist, as an Agent Mode tool or on the MCP server', () => {
    const existing = new Set([...declaredTools.map(t => t.name), ...JIRA_TOOLS.map(t => t.name)]);
    const named = [...new Set(JSON.stringify(declaredTools).match(/\bjira_[A-Za-z_]+/g) ?? [])];
    expect(named.filter(name => !existing.has(name))).toEqual([]);
  });
});

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

describe('jira_uploadAttachment confirmation (R10: names ticket, file, and size)', () => {
  it('names the ticket, file path, and size', () => {
    const confirmation = buildUploadAttachmentConfirmation('VSJI-38', '/workspace/report.pdf', 2_097_152);
    expect(confirmation.title).toContain('VSJI-38');
    expect(confirmation.message).toContain('VSJI-38');
    expect(confirmation.message).toContain('/workspace/report.pdf');
    expect(confirmation.message).toContain('2.0 MB');
  });
});

describe('jira_uploadAttachment tool registration (R9)', () => {
  it('is declared under contributes.languageModelTools with ticketKey and filePath inputs', () => {
    const tool = declaredTools.find(t => t.name === 'jira_uploadAttachment')!;
    expect(tool).toBeDefined();
    expect(tool.inputSchema.required).toEqual(['ticketKey', 'filePath']);
    expect(tool.inputSchema.properties).toHaveProperty('ticketKey');
    expect(tool.inputSchema.properties).toHaveProperty('filePath');
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

  it('points to the MCP list-templates tool for a template name', () => {
    const message = formatIssueTypeOptionsMessage('PROJ', ['Bug']);
    expect(message).toContain(LIST_TEMPLATES_TOOL);
    expect(message).not.toContain('jira_listTemplates');
  });

  it('still returns an actionable message when the issue-type fetch itself failed', () => {
    const message = formatIssueTypeOptionsMessage('PROJ', []);
    expect(message).toContain('No ticket was created');
    expect(message).toContain('issueType');
  });
});
