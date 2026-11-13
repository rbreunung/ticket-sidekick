import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { JIRA_TOOLS } from '../mcp/jiraTools/catalog';
import { defineTool, ToolFailure } from '../mcp/mcpServer';
import { confirmationFor, needsConfirmation, resolveToolsFrom, runExtensionTool } from '../tools/jiraExtensionTools';
import { jiraToolManifest, toolReferenceName } from '../tools/jiraToolManifest';

// The Jira tools offered as extension tools, for machines where the MCP server is not allowed:
// the same tools, declared in package.json as VS Code wants them, asking before they change
// anything.

const manifest = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf-8'));
const declared = (manifest.contributes.languageModelTools as Array<{ name: string }>).filter(t => t.name.startsWith('jira_'));

describe('the Jira tools in package.json', () => {
  it('are exactly the tools of the catalog, with the same descriptions and inputs (run node scripts/sync-jira-tools.mjs after a change)', () => {
    expect(declared).toEqual(JSON.parse(JSON.stringify(jiraToolManifest(JIRA_TOOLS))));
  });

  it('are shown to Copilot only while the setting asks for extension tools', () => {
    for (const tool of declared as Array<{ name: string; when?: string }>) expect(tool.when, tool.name).toBe('ticketSidekick.jiraExtensionTools');
    const sections = manifest.contributes.configuration as Array<{ properties: Record<string, unknown> }>;
    const setting = sections.map(s => s.properties['ticketSidekick.jira.toolsFrom']).find(Boolean);
    expect(setting).toMatchObject({ enum: ['mcp', 'extension'], default: 'mcp' });
  });

  it('carry required inputs and descriptions the model can read', () => {
    const view = jiraToolManifest(JIRA_TOOLS).find(t => t.name === 'jira_add_comment')!;
    expect(view.inputSchema).toMatchObject({ type: 'object', required: ['ticketKey', 'comment'] });
    expect((view.inputSchema.properties as Record<string, { description?: string }>).ticketKey.description).toContain('PROJ-123');
    expect(toolReferenceName('jira_add_comment')).toBe('jiraAddComment');
  });
});

describe('the setting that chooses the route', () => {
  it('is MCP unless it says extension', () => {
    expect(resolveToolsFrom('extension')).toBe('extension');
    expect(resolveToolsFrom('mcp')).toBe('mcp');
    expect(resolveToolsFrom(undefined)).toBe('mcp');
    expect(resolveToolsFrom('Extension')).toBe('mcp');
  });
});

const shape = { ticketKey: z.string().describe('The ticket key.'), comment: z.string().optional() };
const calls: unknown[] = [];
const demo = defineTool<{ fail?: 'tool' | 'crash' }, typeof shape>({
  name: 'jira_demo', title: 'Add a demo comment', description: 'Demo.', inputSchema: shape, annotations: { destructiveHint: true },
  handler: async (args, deps) => {
    if (deps.fail === 'tool') throw new ToolFailure('Could not add the comment: Jira answered HTTP 502 (Bad Gateway).', 'HTTP 502');
    if (deps.fail === 'crash') throw new Error('unexpected');
    calls.push(args);
    return `Commented on ${args.ticketKey}.`;
  },
});

describe('running an extension tool', () => {
  it('runs the tool with the input and returns its answer', async () => {
    expect(await runExtensionTool(demo, { ticketKey: 'PROJ-1', comment: 'done' }, {})).toBe('Commented on PROJ-1.');
    expect(calls.at(-1)).toEqual({ ticketKey: 'PROJ-1', comment: 'done' });
  });

  it('answers input that does not fit with what is wrong, and does not run the tool', async () => {
    const before = calls.length;
    expect(await runExtensionTool(demo, { comment: 5 }, {})).toMatch(/^The input for jira_demo is not valid: ticketKey: Required; comment: /);
    expect(await runExtensionTool(demo, undefined, {})).toContain('ticketKey: Required');
    expect(calls).toHaveLength(before);
  });

  it('answers a failure the tool words itself as text, as over MCP, and lets an unexpected one through', async () => {
    expect(await runExtensionTool(demo, { ticketKey: 'PROJ-1' }, { fail: 'tool' })).toBe('Could not add the comment: Jira answered HTTP 502 (Bad Gateway).');
    await expect(runExtensionTool(demo, { ticketKey: 'PROJ-1' }, { fail: 'crash' })).rejects.toThrow('unexpected');
  });
});

describe('asking before a tool changes something', () => {
  it('asks for every tool that is not read-only, and for none that is', () => {
    const byName = (name: string) => JIRA_TOOLS.find(t => t.name === name)!;
    for (const name of ['jira_add_comment', 'jira_update_field', 'jira_move_ticket', 'jira_create_ticket', 'jira_upload_attachment', 'jira_load_ticket']) {
      expect(needsConfirmation(byName(name)), name).toBe(true);
    }
    for (const name of ['jira_view_ticket', 'jira_find_tickets', 'jira_check_connection', 'jira_list_fields', 'jira_open_board']) {
      expect(needsConfirmation(byName(name)), name).toBe(false);
    }
  });

  it('shows the tool\'s title and every value that will be written', () => {
    const asked = confirmationFor(demo as never, { ticketKey: 'PROJ-1', comment: 'Fixed in build 42', empty: '' });
    expect(asked).toEqual({ title: 'Add a demo comment?', lines: [{ name: 'ticketKey', value: 'PROJ-1' }, { name: 'comment', value: 'Fixed in build 42' }] });
  });

  it('cuts a very long value', () => {
    const asked = confirmationFor(demo as never, { ticketKey: 'PROJ-1', comment: 'x'.repeat(5000) });
    expect(asked.lines[1].value).toHaveLength(1501);
  });
});
