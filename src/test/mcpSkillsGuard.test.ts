import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { basename, dirname, resolve } from 'path';
import { BOARD_CANVASES } from '../canvas/openDecision';
import {
  ADD_COMMENT_TOOL, CHECK_CONNECTION_TOOL, CREATE_TICKET_TOOL, FIND_TICKETS_TOOL, JIRA_TOOLS, LIST_TEMPLATES_TOOL,
  LOAD_TICKET_TOOL, MOVE_TICKET_TOOL, UPDATE_FIELD_TOOL, VIEW_TICKET_TOOL,
} from '../mcp/jiraTools/catalog';

// The skills the extension contributes (package.json `contributes.chatSkills`) are prose an agent
// follows, so nothing else notices when one names a tool that does not exist, or when VS Code
// would refuse or hide it. This guard reads every contributed skill and checks what can be
// checked: the frontmatter VS Code needs, model invocation left on, and every `jira_` tool name
// it uses being one the MCP server offers.

const root = process.cwd();
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf-8'));
const contributedSkills: Array<{ path: string }> = pkg.contributes.chatSkills ?? [];
const catalogNames = JIRA_TOOLS.map(t => t.name);

/** The `key: value` lines between the opening and closing `---` of a SKILL.md. */
function parseFrontmatter(text: string): Record<string, string> | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) return undefined;
  const fields: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (field) fields[field[1]] = field[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return fields;
}

/**
 * Skills only the user starts, by typing them: the `ts-` skills, except `ts-jira-create`. They
 * keep model invocation off, so they never compete with the tools for a plain request, and a
 * model without thinking cannot drift into one in place of another request. `ts-jira-create`
 * keeps it on on purpose: a plain request for a new ticket then goes through a template and a
 * draft instead of a bare create.
 */
const MODEL_INVOCABLE_TS_SKILLS: ReadonlySet<string> = new Set(['ts-jira-create']);

function isExplicitOnly(folder: string): boolean {
  return folder.startsWith('ts-') && !MODEL_INVOCABLE_TS_SKILLS.has(folder);
}

/** What is wrong with one skill: its folder name, its SKILL.md text, the tool names that exist. */
function skillProblems(folder: string, text: string, toolNames: readonly string[]): string[] {
  const problems: string[] = [];
  const front = parseFrontmatter(text);
  if (!front) return ['has no frontmatter'];
  if (front.name !== folder) problems.push(`frontmatter name "${front.name ?? ''}" differs from its folder "${folder}"`);
  if (!front.description) problems.push('has no description');
  const explicitOnly = front['disable-model-invocation'] === 'true';
  if (isExplicitOnly(folder) && !explicitOnly) problems.push('is an explicit-only skill but leaves model invocation on');
  if (!isExplicitOnly(folder) && 'disable-model-invocation' in front) problems.push('sets disable-model-invocation, so the agent cannot run it by itself');
  for (const tool of new Set(text.match(/\bjira_[A-Za-z_]+/g) ?? [])) {
    if (!toolNames.includes(tool)) problems.push(`names ${tool}, which the MCP server does not offer`);
  }
  return problems;
}

/** Positions of `names` in `text`, in the order given; -1 for one that is missing. */
function positions(text: string, names: readonly string[]): number[] {
  return names.map(name => text.indexOf(name));
}

describe('contributed skills', () => {
  it('contributes at least one skill, each from a SKILL.md that exists', () => {
    expect(contributedSkills.length).toBeGreaterThan(0);
    const missing = contributedSkills.map(s => s.path).filter(p => basename(p) !== 'SKILL.md' || !existsSync(resolve(root, p)));
    expect(missing).toEqual([]);
  });

  it('contributes every skill in skills/', () => {
    const contributed = contributedSkills.map(s => basename(dirname(resolve(root, s.path)))).sort();
    const onDisk = readdirSync(resolve(root, 'skills'), { withFileTypes: true })
      .filter(e => e.isDirectory() && existsSync(resolve(root, 'skills', e.name, 'SKILL.md')))
      .map(e => e.name)
      .sort();
    expect(contributed).toEqual(onDisk);
  });

  it.each(contributedSkills.map(s => s.path))('%s passes the guard', skillPath => {
    const file = resolve(root, skillPath);
    expect(skillProblems(basename(dirname(file)), readFileSync(file, 'utf-8'), catalogNames)).toEqual([]);
  });
});

describe('the skill guard', () => {
  const good = '---\nname: jira-sample\ndescription: Does a sample thing.\n---\n\nCall `jira_view_ticket`.\n';

  it('passes a skill that names only tools the MCP server offers', () => {
    expect(skillProblems('jira-sample', good, catalogNames)).toEqual([]);
  });

  it('fails a skill that names a tool that does not exist', () => {
    const text = good.replace('`jira_view_ticket`', '`jira_view_ticket`, then `jira_summarize_ticket`');
    expect(skillProblems('jira-sample', text, catalogNames)).toEqual(['names jira_summarize_ticket, which the MCP server does not offer']);
  });

  it('fails a skill that names a removed Agent Mode tool', () => {
    const text = good.replace('`jira_view_ticket`', '`jira_getTicket`');
    expect(skillProblems('jira-sample', text, catalogNames)).toEqual(['names jira_getTicket, which the MCP server does not offer']);
  });

  it('fails a skill whose name differs from its folder', () => {
    expect(skillProblems('jira-other', good, catalogNames)).toEqual(['frontmatter name "jira-sample" differs from its folder "jira-other"']);
  });

  it('fails a skill that turns off model invocation', () => {
    const text = good.replace('description:', 'disable-model-invocation: true\ndescription:');
    expect(skillProblems('jira-sample', text, catalogNames)).toEqual(['sets disable-model-invocation, so the agent cannot run it by itself']);
  });

  it('fails a ts- command skill that leaves model invocation on', () => {
    const text = good.replace('name: jira-sample', 'name: ts-sample');
    expect(skillProblems('ts-sample', text, catalogNames)).toEqual(['is an explicit-only skill but leaves model invocation on']);
  });

  it('passes a ts- command skill with model invocation off', () => {
    const text = good.replace('name: jira-sample', 'name: ts-sample').replace('description:', 'disable-model-invocation: true\ndescription:');
    expect(skillProblems('ts-sample', text, catalogNames)).toEqual([]);
  });

  it('fails a skill without frontmatter', () => {
    expect(skillProblems('jira-sample', 'Call `jira_view_ticket`.', catalogNames)).toEqual(['has no frontmatter']);
  });
});

describe('the /ts-jira-brief skill', () => {
  const brief = readFileSync(resolve(root, 'skills/ts-jira-brief/SKILL.md'), 'utf-8');
  const sections = [
    'Problem or goal',
    'Context',
    'Steps to reproduce',
    'Acceptance criteria',
    'Decisions and findings from comments',
    'Current state',
    'Open questions and missing information',
    'Sources used',
  ];

  it('names all eight sections, in order', () => {
    const at = positions(brief, sections);
    expect(at.filter(p => p < 0), 'a section is missing').toEqual([]);
    expect(at).toEqual([...at].sort((a, b) => a - b));
  });

  it('asks for the expected and actual result with the steps to reproduce, and the author and date of each decision', () => {
    expect(brief).toMatch(/expected result and the actual result/);
    expect(brief).toMatch(/author and date/);
  });

  it('says what an uncovered section says, marks derived acceptance criteria, and lists unreadable attachments', () => {
    expect(brief).toContain('"not stated in the ticket"');
    expect(brief).toContain('"(derived)"');
    expect(brief).toMatch(/attachment you could not read/);
  });

  it('runs only when the user types it, with the ticket key as its argument', () => {
    const front = parseFrontmatter(brief) ?? {};
    expect(front['disable-model-invocation']).toBe('true');
    expect(front['argument-hint']).toBe('<ticket key>');
  });

  it('views the ticket, then loads it and reads the attachments from .jira-context', () => {
    const at = positions(brief, [VIEW_TICKET_TOOL, LOAD_TICKET_TOOL, '.jira-context/']);
    expect(at.every(p => p >= 0)).toBe(true);
    expect(at).toEqual([...at].sort((a, b) => a - b));
  });

  it('names extra attachments only when the user gave them, and otherwise asks with the numbered list first', () => {
    expect(brief).toContain('Pass `attachments` only with attachment names the user\'s own request already gave; never add names you picked yourself.');
    const at = positions(brief, ['numbered list', 'ask which to download', 'Wait for the answer', 'call `jira_load_ticket` again']);
    expect(at.every(p => p >= 0)).toBe(true);
    expect(at).toEqual([...at].sort((a, b) => a - b));
  });
});

describe('the section-order check', () => {
  it('notices sections out of order', () => {
    const at = positions('Context, then Problem or goal', ['Problem or goal', 'Context']);
    expect(at).not.toEqual([...at].sort((a, b) => a - b));
  });
});

// Every basic `@jira` command keeps a way to do the same thing in a chat without `@jira`: the MCP
// tools it maps to must all exist, and so must the skills it maps to.
const BASIC_COMMANDS: Record<string, readonly string[]> = {
  view: [VIEW_TICKET_TOOL],
  load: [LOAD_TICKET_TOOL],
  search: ['canvas:ticket-list', FIND_TICKETS_TOOL],
  comment: [ADD_COMMENT_TOOL],
  field: [UPDATE_FIELD_TOOL],
  move: [MOVE_TICKET_TOOL],
  create: [CREATE_TICKET_TOOL, '/ts-jira-create'],
  check: [CHECK_CONNECTION_TOOL],
  'security-report': ['canvas:security-report'],
};

/** The basic commands whose tools or skills do not all exist. */
function coverageGaps(coverage: Record<string, readonly string[]>, toolNames: readonly string[], skillNames: readonly string[]): string[] {
  const exists = (name: string) => (name.startsWith('canvas:') ? BOARD_CANVASES.some(c => c.id === name.slice('canvas:'.length))
    : name.startsWith('/') ? skillNames.includes(name.slice(1)) : toolNames.includes(name));
  return Object.entries(coverage).filter(([, names]) => names.length === 0 || !names.every(exists)).map(([command]) => command);
}

const skillNames = contributedSkills.map(s => basename(dirname(s.path)));

describe('basic @jira commands without @jira', () => {
  it('maps every basic @jira slash command to tools, skills and canvases that exist', () => {
    const jira = pkg.contributes.chatParticipants.find((p: { id: string }) => p.id === 'ticket-sidekick.jira');
    const commands = (jira.commands as Array<{ name: string }>).map(c => c.name).sort();
    expect(Object.keys(BASIC_COMMANDS).sort()).toEqual(commands);
    expect(coverageGaps(BASIC_COMMANDS, catalogNames, skillNames)).toEqual([]);
  });

  it('fails for create when the create tool leaves the catalog', () => {
    const withoutCreate = catalogNames.filter(name => name !== CREATE_TICKET_TOOL);
    expect(coverageGaps(BASIC_COMMANDS, withoutCreate, skillNames)).toEqual(['create']);
  });
});

describe('the /ts-jira-create skill', () => {
  const create = readFileSync(resolve(root, 'skills/ts-jira-create/SKILL.md'), 'utf-8');

  it('looks at the templates first and creates the ticket last', () => {
    const at = positions(create, [LIST_TEMPLATES_TOOL, CREATE_TICKET_TOOL]);
    expect(at.every(p => p >= 0)).toBe(true);
    expect(at[0]).toBeLessThan(at[1]);
  });

  it('starts by itself for a plain request for a new ticket, and not for other ticket work', () => {
    const description = parseFrontmatter(create)?.description ?? '';
    expect(parseFrontmatter(create)).not.toHaveProperty('disable-model-invocation');
    expect(description).toContain('Use when asked to create, open, file or raise a Jira ticket, bug or story.');
    expect(description).toContain('Not for showing, loading, searching or changing existing tickets.');
  });

  it('asks only for what is missing, never picks the issue type, and shows the draft before creating', () => {
    expect(create).toMatch(/Ask only for what you cannot take from the request/);
    expect(create).toMatch(/Never pick an issue type yourself/);
    expect(create).toMatch(/Show the user the project, the template or issue type, the summary and the description/);
  });
});

describe('the /ts-jira command skill', () => {
  const router = readFileSync(resolve(root, 'skills/ts-jira/SKILL.md'), 'utf-8');
  /** The table rows: the command word and what the row does. */
  const rows = [...router.matchAll(/^\| ([a-z][a-z-]*)(?![a-z-])[^|]*\| ([^|]+) \|$/gm)].map(m => ({ command: m[1], action: m[2] }));

  it('has a row for every MCP tool, so a new tool cannot be forgotten', () => {
    const called = rows.flatMap(r => r.action.match(/\bjira_[a-z_]+/g) ?? []);
    // Creating is left to the /ts-jira-create skill, which drafts the ticket with the user first.
    // Finding is for Copilot's own lookups and questions; a list for the user opens the ticket list board.
    const direct = catalogNames.filter(name => name !== CREATE_TICKET_TOOL && name !== FIND_TICKETS_TOOL);
    expect([...new Set(called)].sort()).toEqual([...direct].sort());
  });

  it('names no skill, so a weak model is not drawn into running one', () => {
    for (const skill of skillNames.filter(name => name !== 'ts-jira')) expect(router, skill).not.toContain(skill);
  });

  it('puts what the user typed next to the cases', () => {
    const body = router.slice(router.indexOf('\n---', 4) + 4).trim();
    expect(body.split('\n')[0]).toBe('The user typed after /ts-jira: `$ARGUMENTS`');
  });

  it('lists every command of the table in its argument hint, in the same order', () => {
    const hint = parseFrontmatter(router)?.['argument-hint'] ?? '';
    expect(hint.split(' ')[0].split('|')).toEqual(rows.map(r => r.command));
  });

  /** The numbered cases, in order, from the skill's body. */
  const cases = [...router.matchAll(/^(\d)\. (.+)$/gm)].map(m => ({ n: Number(m[1]), text: m[2] }));

  it('never invokes a skill', () => {
    expect(router).toContain('Follow only these rules, and never invoke a skill from here.');
  });

  it('checks an empty command, help, an unknown command and a missing argument, in that order, before running anything', () => {
    expect(cases.map(c => c.n)).toEqual([1, 2, 3, 4, 5]);
    expect(cases[0].text).toBe('Nothing typed: call no tool. Reply with exactly the help text below, as a code block. Stop.');
    expect(cases[1].text).toMatch(/^The first word is `help`: run nothing\./);
    expect(cases[1].text).toContain('read `help-brief.md` or `help-create.md` in this skill\'s folder and reply with its text exactly; read no other file and call no other tool.');
    expect(cases[1].text).toContain('call no tool and reply with only its line as a code block');
    expect(cases[2].text).toBe('The first word is not a command of the table: call no tool. Reply with exactly the help text. Stop.');
    expect(cases[3].text).toMatch(/^An argument in angle brackets that the command needs is missing: call no tool\./);
    expect(cases[4].text).toMatch(/^Otherwise make the one call the table names/);
    expect(router.indexOf('5. Otherwise')).toBeLessThan(router.indexOf('| Command |'));
  });

  it('starts the help with the usage line and sets the commands apart with separator lines', () => {
    const help = router.slice(router.indexOf('```text') + 8, router.indexOf('```', router.indexOf('```text') + 8)).split('\n');
    expect(help[0]).toBe('Usage: /ts-jira <command> [arguments]');
    expect(help[1]).toMatch(/^-{20,}$/);
    expect(help.at(-4)).toMatch(/^-{20,}$/);
    expect(help.at(-3)).toBe('Without KEY, load and view use the ticket of the git branch.');
    expect(help.at(-2)).toBe('A developer brief or a guided ticket create: help brief, help create');
  });

  it('prints a help line for every command of the table, in the same order', () => {
    const help = router.slice(router.indexOf('Usage: /ts-jira'), router.indexOf('```', router.indexOf('Usage: /ts-jira')));
    const helpCommands = [...help.matchAll(/^ {2}([a-z][a-z-]*)(?![a-z-])/gm)].map(m => m[1]);
    expect(helpCommands).toEqual(rows.map(r => r.command));
  });
});

describe('the help pages /ts-jira prints for brief and create', () => {
  const pages = [
    { file: 'help-brief.md', skill: 'ts-jira-brief', plain: '/ts-jira view', started: 'Copilot runs /ts-jira-brief only when you type it.' },
    { file: 'help-create.md', skill: 'ts-jira-create', plain: 'call the create ticket tool directly', started: 'Copilot also starts it by itself when you ask for a new ticket in your own words' },
  ];

  it.each(pages)('$file names a skill that exists, how to use it, when it starts, and what to do without it', ({ file, skill, plain, started }) => {
    const page = readFileSync(resolve(root, 'skills/ts-jira', file), 'utf-8');
    expect(skillNames).toContain(skill);
    expect(page.split('\n')[0]).toMatch(new RegExp(`^/${skill} `));
    expect(page).toContain(`Example: /${skill} `);
    expect(page).toContain('Without it:');
    expect(page).toContain(plain);
    expect(page).toContain(started);
  });

  it('keeps every skill name out of /ts-jira itself, so it only reaches the model on help brief or help create', () => {
    const router = readFileSync(resolve(root, 'skills/ts-jira/SKILL.md'), 'utf-8');
    for (const page of pages) expect(router).not.toContain(page.skill);
  });
});
