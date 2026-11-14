import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { JIRA_TOOLS } from '../tools/jiraTools/catalog';
import { callTool, defineTool, ToolFailure } from '../tools/toolDefinition';
import { confirmationFor, confirmationWithPreview, needsConfirmation } from '../tools/jiraToolConfirmation';
import { jiraToolManifest, toolReferenceName } from '../tools/jiraToolManifest';

// The Jira tools as Copilot gets them: VS Code language model tools ("extension tools"), declared
// in package.json as VS Code wants them, asking before they change anything.

const manifest = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf-8'));
const declared = (manifest.contributes.languageModelTools as Array<{ name: string }>).filter(t => t.name.startsWith('jira_'));

describe('the Jira tools in package.json', () => {
  it('are exactly the tools of the catalog, with the same descriptions and inputs (run node scripts/sync-jira-tools.mjs after a change)', () => {
    expect(declared).toEqual(JSON.parse(JSON.stringify(jiraToolManifest(JIRA_TOOLS))));
  });

  it('are always offered: no setting and no context key hides them', () => {
    for (const tool of declared as Array<{ name: string; when?: string }>) expect(tool.when, tool.name).toBeUndefined();
    const sections = manifest.contributes.configuration as Array<{ properties: Record<string, unknown> }>;
    expect(sections.some(s => 'ticketSidekick.jira.toolsFrom' in s.properties)).toBe(false);
  });

  it('carry required inputs and descriptions the model can read', () => {
    const view = jiraToolManifest(JIRA_TOOLS).find(t => t.name === 'jira_add_comment')!;
    expect(view.inputSchema).toMatchObject({ type: 'object', required: ['ticketKey', 'comment'] });
    expect((view.inputSchema.properties as Record<string, { description?: string }>).ticketKey.description).toContain('PROJ-123');
    expect(toolReferenceName('jira_add_comment')).toBe('jiraAddComment');
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

describe('running a tool', () => {
  it('runs the tool with the input and returns its answer', async () => {
    expect(await callTool(demo, { ticketKey: 'PROJ-1', comment: 'done' }, {})).toEqual({ text: 'Commented on PROJ-1.', failed: false });
    expect(calls.at(-1)).toEqual({ ticketKey: 'PROJ-1', comment: 'done' });
  });

  it('answers input that does not fit with what is wrong, and does not run the tool', async () => {
    const before = calls.length;
    const refused = await callTool(demo, { comment: 5 }, {});
    expect(refused.text).toMatch(/^The input for jira_demo is not valid: ticketKey: Invalid input: expected string, received undefined; comment: /);
    expect(refused.failed).toBe(true);
    expect((await callTool(demo, undefined, {})).text).toContain('ticketKey: Invalid input: expected string, received undefined');
    expect(calls).toHaveLength(before);
  });

  it('answers a failure the tool words itself as text with its label, and lets an unexpected one through', async () => {
    expect(await callTool(demo, { ticketKey: 'PROJ-1' }, { fail: 'tool' })).toEqual({
      text: 'Could not add the comment: Jira answered HTTP 502 (Bad Gateway).', failed: true, error: 'HTTP 502',
    });
    await expect(callTool(demo, { ticketKey: 'PROJ-1' }, { fail: 'crash' })).rejects.toThrow('unexpected');
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

const previewed = defineTool<{ previewFails?: boolean }, typeof shape>({
  name: 'jira_demo_preview', title: 'Rewrite a demo description', description: 'Demo.', inputSchema: shape, annotations: { destructiveHint: true },
  handler: async () => 'done',
  preview: async (args, deps) => {
    if (deps.previewFails) throw Object.assign(new Error('Issue does not exist'), { status: 404 });
    return [{ name: 'Resulting description', value: `New text for ${args.ticketKey}` }];
  },
});

describe('showing what a tool will write before it runs', () => {
  it('shows exactly the input values for a tool without a preview', async () => {
    expect(await confirmationWithPreview(demo, { ticketKey: 'PROJ-1', comment: 'done' }, {}))
      .toEqual(confirmationFor(demo, { ticketKey: 'PROJ-1', comment: 'done' }));
  });

  it('shows the input values and then what the tool worked out it will write', async () => {
    const asked = await confirmationWithPreview(previewed, { ticketKey: 'PROJ-1' }, {});
    expect(asked).toEqual({
      title: 'Rewrite a demo description?',
      lines: [{ name: 'ticketKey', value: 'PROJ-1' }, { name: 'Resulting description', value: 'New text for PROJ-1' }],
    });
  });

  it('still asks, with the reason, when the preview cannot be built', async () => {
    const asked = await confirmationWithPreview(previewed, { ticketKey: 'PROJ-404' }, { previewFails: true });
    expect(asked.lines).toEqual([
      { name: 'ticketKey', value: 'PROJ-404' },
      { name: 'Preview', value: 'Could not preview what will be written: Issue does not exist' },
    ]);
  });

  it('does not preview input that does not fit the tool', async () => {
    const asked = await confirmationWithPreview(previewed, { ticketKey: 5 }, {});
    expect(asked.lines).toEqual([{ name: 'ticketKey', value: '5' }]);
  });
});
