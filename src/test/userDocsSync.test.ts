import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { basename, dirname, resolve } from 'path';
import { JIRA_TOOLS } from '../tools/jiraTools/catalog';

// The user manual (README.md + docs/manual/) is written by hand, so nothing else notices when a
// setting is added, renamed, or has its default changed in package.json. These tests are that
// check: every setting a user can change is documented, every documented setting still exists,
// and every default the docs state matches the real one.

const root = process.cwd();
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf-8'));
const settings: Record<string, { default?: unknown }> = Object.assign(
  {},
  ...[].concat(pkg.contributes.configuration).map((group: { properties?: object }) => group.properties ?? {}),
);

const manualDir = resolve(root, 'docs/manual');
const userDocs: Array<{ name: string; text: string }> = [
  { name: 'README.md', text: readFileSync(resolve(root, 'README.md'), 'utf-8') },
  ...readdirSync(manualDir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => ({ name: `docs/manual/${f}`, text: readFileSync(resolve(manualDir, f), 'utf-8') })),
];
const settingsReference = userDocs.find((d) => d.name === 'docs/manual/settings-reference.md')!.text;

const SETTING_KEY = /ticketSidekick\.[A-Za-z]+\.[A-Za-z]+/g;
const TOOL_NAME = /\b(?:jira|bitbucket)_[A-Za-z_]+\b/g;

/** The catalog tools, and the inputs of each, that a page does not name in `code`. */
function undocumentedCatalogTools(tools: ReadonlyArray<{ name: string; inputSchema: object }>, page: string): string[] {
  const named = (word: string) => page.includes(`\`${word}\``);
  return tools.flatMap((t) => [
    ...(named(t.name) ? [] : [t.name]),
    ...Object.keys(t.inputSchema).filter((input) => !named(input)).map((input) => `${t.name}: ${input}`),
  ]);
}

/** Table rows naming a setting in one cell and a `code` default in the next cell. */
function documentedDefaults(text: string): Array<{ key: string; cell: string }> {
  const rows: Array<{ key: string; cell: string }> = [];
  for (const line of text.split('\n')) {
    if (!line.trim().startsWith('|')) continue;
    const cells = line.split('|').map((c) => c.trim());
    for (let i = 0; i < cells.length - 1; i++) {
      const key = cells[i].match(/^`(ticketSidekick\.[A-Za-z]+\.[A-Za-z]+)`$/)?.[1];
      const code = cells[i + 1].match(/^`(.*)`$/)?.[1];
      if (key && code !== undefined) rows.push({ key, cell: code });
    }
  }
  return rows;
}

/** A default cell is JSON (`"datacenter"`, `4`, `["New"]`) or, in some tables, a bare word (`High`). */
function parseDefaultCell(cell: string): unknown {
  try {
    return JSON.parse(cell);
  } catch {
    return cell;
  }
}

describe('user manual stays in sync with package.json settings', () => {
  it('lists every setting in the settings reference', () => {
    const missing = Object.keys(settings).filter((key) => !settingsReference.includes(`\`${key}\``));
    expect(missing, 'add these to docs/manual/settings-reference.md').toEqual([]);
  });

  it('mentions no setting that package.json does not define', () => {
    const unknown = userDocs.flatMap(({ name, text }) =>
      [...new Set(text.match(SETTING_KEY) ?? [])].filter((key) => !(key in settings)).map((key) => `${name}: ${key}`),
    );
    expect(unknown, 'renamed or removed settings still in the docs').toEqual([]);
  });

  it('states the same default as package.json wherever a table gives one', () => {
    const wrong = userDocs.flatMap(({ name, text }) =>
      documentedDefaults(text)
        .filter(({ key }) => key in settings)
        .filter(({ key, cell }) => JSON.stringify(parseDefaultCell(cell)) !== JSON.stringify(settings[key].default))
        .map(({ key, cell }) => `${name}: ${key} documented as ${cell}, package.json says ${JSON.stringify(settings[key].default)}`),
    );
    expect(wrong).toEqual([]);
  });
});

describe('user manual covers everything else users see from package.json', () => {
  const contributes = pkg.contributes;
  const allDocs = userDocs.map((d) => d.text).join('\n');
  const readme = userDocs.find((d) => d.name === 'README.md')!.text;
  const toolsPage = userDocs.find((d) => d.name === 'docs/manual/agent-mode-tools.md')?.text ?? '';
  const copilotToolsPage = userDocs.find((d) => d.name === 'docs/manual/copilot-tools.md')?.text ?? '';
  const agentModeTools = contributes.languageModelTools as Array<{ name: string; toolReferenceName?: string }>;

  it('names every Command Palette command by its title', () => {
    const missing = (contributes.commands as Array<{ title: string }>)
      .map((c) => c.title)
      .filter((title) => !allDocs.includes(title));
    expect(missing, 'add these command titles to README.md or docs/manual/').toEqual([]);
  });

  it('lists every slash command in the README', () => {
    const missing = (contributes.chatParticipants as Array<{ name: string; commands?: Array<{ name: string }> }>)
      .flatMap((p) => (p.commands ?? []).map((c) => `@${p.name} /${c.name}`))
      .filter((command) => !readme.includes(`\`${command}\``));
    expect(missing, 'add these to the slash-command tables in README.md').toEqual([]);
  });

  it('lists every Agent Mode tool, with its # reference, on the tools page', () => {
    const missing = agentModeTools
      .flatMap((t) => [`\`${t.name}\``, ...(t.toolReferenceName ? [`\`#${t.toolReferenceName}\``] : [])])
      .filter((entry) => !toolsPage.includes(entry));
    expect(missing, 'add these to docs/manual/agent-mode-tools.md').toEqual([]);
  });

  it('lists every Jira tool of the catalog, with its inputs, on the Copilot tools page', () => {
    expect(undocumentedCatalogTools(JIRA_TOOLS, copilotToolsPage), 'add these to docs/manual/copilot-tools.md').toEqual([]);
  });

  it('names every contributed skill, as its slash command, on the Copilot tools page', () => {
    const missing = ((contributes.chatSkills ?? []) as Array<{ path: string }>)
      .map((skill) => `\`/${basename(dirname(skill.path))}\``)
      .filter((command) => !copilotToolsPage.includes(command));
    expect(missing, 'add these to docs/manual/copilot-tools.md').toEqual([]);
  });

  it('names no Jira or Bitbucket tool that neither package.json nor the catalog offers', () => {
    const existing = new Set([...agentModeTools.map((t) => t.name), ...JIRA_TOOLS.map((t) => t.name)]);
    const unknown = userDocs.flatMap(({ name, text }) =>
      [...new Set(text.match(TOOL_NAME) ?? [])].filter((tool) => !existing.has(tool)).map((tool) => `${name}: ${tool}`),
    );
    expect(unknown, 'removed or renamed tools still in the docs').toEqual([]);
  });
});

describe('the Copilot tools page check', () => {
  const tools = [
    { name: 'jira_view_ticket', inputSchema: { ticketKey: {} } },
    { name: 'jira_find_tickets', inputSchema: { jql: {} } },
  ];

  it('passes when the page names every tool and input', () => {
    expect(undocumentedCatalogTools(tools, '`jira_view_ticket` takes `ticketKey`; `jira_find_tickets` takes `jql`.')).toEqual([]);
  });

  it('fails when a catalog tool is missing from the page', () => {
    expect(undocumentedCatalogTools(tools, '`jira_view_ticket` takes `ticketKey` and `jql`.')).toEqual(['jira_find_tickets']);
  });

  it('fails when an input of a tool is missing from the page', () => {
    expect(undocumentedCatalogTools(tools, '`jira_view_ticket` takes `ticketKey`; `jira_find_tickets` searches.')).toEqual(['jira_find_tickets: jql']);
  });
});
