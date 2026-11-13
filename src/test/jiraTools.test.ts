import { describe, it, expect } from 'vitest';
import { formatIssueTypeOptionsMessage } from '../participant/sessionState';
import { CREATE_TICKET_TOOL, LIST_TEMPLATES_TOOL } from '../mcp/jiraTools/catalog';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// Jira's tools are served by the extension's MCP server or, where that is not allowed, as
// extension tools. Each is declared once and hidden behind one context key, so no Jira capability
// is offered to the model twice.

const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf-8'));
const declaredTools: Array<{ name: string }> = pkg.contributes.languageModelTools;

describe('Jira tools in Agent Mode', () => {
  it('declares each Jira tool once, shown only while the tools come from the extension', () => {
    const jira = (declaredTools as Array<{ name: string; when?: string }>).filter(t => t.name.startsWith('jira_'));
    expect(new Set(jira.map(t => t.name)).size).toBe(jira.length);
    expect(jira.every(t => t.when === 'ticketSidekick.jiraExtensionTools')).toBe(true);
  });
});

describe('create ticket without an issue type', () => {
  it('lists the project\'s valid issue types and creates nothing', () => {
    const message = formatIssueTypeOptionsMessage('PROJ', ['Bug', 'Story', 'Task']);
    expect(message).toContain('No ticket was created');
    expect(message).toContain('Bug');
    expect(message).toContain('Story');
    expect(message).toContain('Task');
  });

  it('points at the MCP create and list-templates tools for the next call', () => {
    const message = formatIssueTypeOptionsMessage('PROJ', ['Bug']);
    expect(message).toContain(CREATE_TICKET_TOOL);
    expect(message).toContain(LIST_TEMPLATES_TOOL);
    expect(message).not.toContain('jira_createTicket');
  });

  it('still returns an actionable message when the issue-type fetch itself failed', () => {
    const message = formatIssueTypeOptionsMessage('PROJ', []);
    expect(message).toContain('No ticket was created');
    expect(message).toContain('issueType');
  });
});
