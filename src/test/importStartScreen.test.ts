import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { importSessionId, type ImportRecipe, type ReportKind } from '../boards/import/recipe';
import { ImportStartScreen, reportReaderOf, type ImportStartDeps, type ReportReader, type StartScreenView } from '../boards/import/startScreen';
import { createVeracodeDescriptor } from '../imports/veracode';
import { createWaltzDescriptor } from '../imports/waltz';
import type { JiraTemplate } from '../templates/TemplateService';
import { buildJiraNotConfiguredMessage } from '../services/setupHints';
import { JiraApiError } from '../utils/apiError';
import type { JiraAccess } from '../tools/jiraTools/jiraAccess';
import type { IJiraClient } from '../jira/IJiraClient';

// The start screen of an import: a developer picks the report kind and the report file; the
// template comes from the kind's setting (asked once and saved when it is empty or stale), the
// issue type from the template (asked from the project when the template names none), and the
// project from the default project setting. Open hands the full recipe on to the import board.

let dir: string;
let settings: Record<ReportKind, string>;
let writes: Array<[ReportKind, string]>;
let templates: JiraTemplate[];
let defaultProject: string;
let configured: boolean;
let projectFails: Error | undefined;
let nextFile: string | undefined;
let pickedFilters: string[];
let stored: Set<string>;
let discarded: string[];
let opened: ImportRecipe[];
let openedSettings: string[];
let readers: Partial<Record<ReportKind, ReportReader>>;

const fakeReader = (items = 3): ReportReader => ({
  read: async () => ({ items: Array.from({ length: items }, (_, i) => i), rawItems: [] }),
  noMatchMessage: 'No components in this report matched your current filters.',
  fileFilter: { label: 'OSS report', extensions: ['xlsx'] },
});

const client = {
  getProject: async (key: string) => {
    if (projectFails) throw projectFails;
    return { key, name: key, issueTypes: [{ id: '1', name: 'Vulnerability', subtask: false }, { id: '2', name: 'Bug', subtask: false }, { id: '3', name: 'Sub-task', subtask: true }] };
  },
} as unknown as IJiraClient;

function deps(): ImportStartDeps {
  return {
    jira: async (): Promise<JiraAccess> => configured
      ? { configured: true, client, config: { baseUrl: 'https://jira.example.com', token: 't', authType: 'datacenter' } as never }
      : { configured: false, config: { baseUrl: 'https://jira.example.com', token: undefined, authType: 'datacenter' } as never },
    defaultProject: () => defaultProject,
    templateSetting: kind => settings[kind],
    writeTemplateSetting: async (kind, name) => { settings[kind] = name; writes.push([kind, name]); },
    templates: () => templates,
    reportReader: kind => readers[kind] ?? fakeReader(),
    pickReportFile: async (_kind, filter) => { pickedFilters.push(filter.label); return nextFile; },
    openSetting: async key => { openedSettings.push(key); },
    hasSession: async id => stored.has(id),
    discardSession: async id => { discarded.push(id); stored.delete(id); },
    openImport: async recipe => { opened.push(recipe); stored.add(importSessionId(recipe)); return { ok: true }; },
  };
}

function report(name = 'report.xlsx', bytes = 10): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, Buffer.alloc(bytes));
  return file;
}

async function screenWithFile(kind: ReportKind = 'waltz', file = report()): Promise<{ screen: ImportStartScreen; view: StartScreenView }> {
  const screen = new ImportStartScreen(deps());
  await screen.handle('kind', { kind });
  nextFile = file;
  const view = await screen.handle('pick-file', {}) as StartScreenView;
  return { screen, view };
}

beforeEach(async () => {
  dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ts-import-start-'));
  settings = { veracode: '', waltz: '' };
  writes = [];
  templates = [{ name: 'OSS finding', issueType: 'Vulnerability' }, { name: 'Plain', issueType: undefined } as JiraTemplate];
  defaultProject = 'PROJ';
  configured = true;
  projectFails = undefined;
  nextFile = undefined;
  pickedFilters = [];
  stored = new Set();
  discarded = [];
  opened = [];
  openedSettings = [];
  readers = {};
});

afterEach(async () => {
  await fs.promises.rm(dir, { recursive: true, force: true });
});

describe('the template', () => {
  it('is asked for once when the setting is empty, saved to the setting, and not asked on the next import', async () => {
    const { screen, view } = await screenWithFile('waltz');
    expect(view.template).toMatchObject({ setting: '', options: ['OSS finding', 'Plain'] });
    expect(view.template.name).toBeUndefined();
    expect(view.canOpen).toBe(false);

    const picked = await screen.handle('template', { name: 'OSS finding' }) as StartScreenView;
    expect(writes).toEqual([['waltz', 'OSS finding']]);
    expect(picked.template).toMatchObject({ name: 'OSS finding', setting: 'OSS finding' });
    expect(picked.template.options).toBeUndefined();

    const second = (await screenWithFile('waltz', report('next.xlsx'))).view;
    expect(second.template.options).toBeUndefined();
    expect(second.template.name).toBe('OSS finding');
    expect(second.canOpen).toBe(true);
    expect(writes).toHaveLength(1);
  });

  it('is asked for again when the setting names a template that no longer exists, and the setting is overwritten', async () => {
    settings.waltz = 'Deleted template';
    const { screen, view } = await screenWithFile('waltz');
    expect(view.template.options).toEqual(['OSS finding', 'Plain']);
    expect(view.template.askReason).toContain('"Deleted template"');
    await screen.handle('template', { name: 'Plain' });
    expect(settings.waltz).toBe('Plain');
  });

  it('refuses a template the workspace does not have, and writes nothing', async () => {
    const { screen } = await screenWithFile('waltz');
    await expect(screen.handle('template', { name: 'Made up' })).rejects.toMatchObject({ status: 400 });
    expect(writes).toEqual([]);
  });

  it('is kept per kind: a Veracode import does not take the Waltz template', async () => {
    settings.waltz = 'OSS finding';
    const { view } = await screenWithFile('veracode', report('report.xml'));
    expect(view.template.options).toEqual(['OSS finding', 'Plain']);
  });
});

describe('the issue type', () => {
  it('is the template\'s own when it names one', async () => {
    settings.waltz = 'OSS finding';
    const { view } = await screenWithFile('waltz');
    expect(view.issueType).toMatchObject({ name: 'Vulnerability', fromTemplate: true });
    expect(view.issueType.options).toBeUndefined();
  });

  it('is asked for from the project\'s issue types when the template names none, never taking the first by itself', async () => {
    settings.waltz = 'Plain';
    const { screen, view } = await screenWithFile('waltz');
    expect(view.issueType).toMatchObject({ fromTemplate: false, options: ['Vulnerability', 'Bug'] });
    expect(view.issueType.name).toBeUndefined();
    expect(view.canOpen).toBe(false);
    await expect(screen.handle('issue-type', { name: 'Sub-task' })).rejects.toMatchObject({ status: 400 });
    const picked = await screen.handle('issue-type', { name: 'Bug' }) as StartScreenView;
    expect(picked.issueType.name).toBe('Bug');
    expect(picked.canOpen).toBe(true);
  });

  it('shows the existing warning when the project\'s issue types cannot be read, and takes a typed one', async () => {
    settings.waltz = 'Plain';
    projectFails = new Error('connect ETIMEDOUT');
    const { screen, view } = await screenWithFile('waltz');
    expect(view.issueType.warning).toBe('Ticket Sidekick: Could not fetch issue types for PROJ — you\'ll be asked to type it. connect ETIMEDOUT');
    expect(view.issueType.typed).toBe(true);
    const typed = await screen.handle('issue-type', { name: '  Story ' }) as StartScreenView;
    expect(typed.issueType.name).toBe('Story');
    expect(typed.canOpen).toBe(true);
  });
});

describe('opening', () => {
  it('hands the full recipe to the import board, with the report path normalised and absolute', async () => {
    settings.veracode = 'OSS finding';
    const file = report('report.xml');
    const { screen } = await screenWithFile('veracode', path.join(dir, '.', 'sub', '..', 'report.xml'));
    await screen.handle('open', {});
    expect(opened).toEqual([{ kind: 'veracode', projectKey: 'PROJ', reportPath: file, templateName: 'OSS finding', issueType: 'Vulnerability' }]);
  });

  it('finds the same session for the same file and project, offers Start over, and keeps the stored template until then', async () => {
    settings.waltz = 'OSS finding';
    const file = report();
    const first = await screenWithFile('waltz', file);
    expect(first.view.stored).toBe(false);
    await first.screen.handle('open', {});

    settings.waltz = 'Plain';
    const again = await screenWithFile('waltz', file);
    expect(again.view.stored).toBe(true);
    await again.screen.handle('issue-type', { name: 'Bug' });
    await again.screen.handle('open', {});
    expect(importSessionId(opened[1])).toBe(importSessionId(opened[0]));
    expect(discarded).toEqual([]);

    await again.screen.handle('start-over', {});
    expect(discarded).toEqual([importSessionId(opened[0])]);
    expect(opened[2]).toMatchObject({ templateName: 'Plain', issueType: 'Bug' });
  });

  it('says why when the import board does not open', async () => {
    settings.waltz = 'OSS finding';
    const { screen } = await screenWithFile('waltz');
    const d = deps();
    const failing = new ImportStartScreen({ ...d, openImport: async () => ({ ok: false, reason: 'there is no board of that name.' }) });
    await failing.handle('kind', { kind: 'waltz' });
    nextFile = report();
    await failing.handle('pick-file', {});
    await expect(failing.handle('open', {})).rejects.toMatchObject({ status: 404, message: 'Not opened: there is no board of that name.' });
    expect((await screen.view()).canOpen).toBe(true);
  });
});

describe('the report file', () => {
  it('is chosen in the native dialog with the kind\'s file filter, and a cancelled dialog leaves the screen as it was', async () => {
    settings.waltz = 'OSS finding';
    const { screen, view } = await screenWithFile('waltz');
    expect(pickedFilters).toEqual(['OSS report']);
    nextFile = undefined;
    const after = await screen.handle('pick-file', {});
    expect(after).toEqual(view);
  });

  it('is refused when it is over the kind\'s size limit, with the size message', async () => {
    settings.waltz = 'OSS finding';
    readers.waltz = reportReaderOf(createWaltzDescriptor(
      { filter: () => ({ minVulnRating: 'High', includeRemediationActions: [''], maxReportBytes: 1024 * 1024 }), minVulnRating: () => 'High', workspaceRoot: () => undefined },
      { reviewColumns: [] },
    ));
    const { screen, view } = await screenWithFile('waltz', report('big.xlsx', 1024 * 1024 + 1));
    expect(view.report.problem).toBe('Could not import report: File exceeds the 1 MB size limit.');
    expect(view.canOpen).toBe(false);
    await expect(screen.handle('open', {})).rejects.toMatchObject({ status: 409 });
    expect(opened).toEqual([]);
  });

  it('that does not parse shows the parse message, and Open stays disabled', async () => {
    settings.veracode = 'OSS finding';
    readers.veracode = reportReaderOf(createVeracodeDescriptor(
      { filter: () => ({ minSeverity: 0, includeStatuses: ['New'], maxReportBytes: 1024 * 1024 }), slaDays: () => undefined },
      { reviewColumns: [] },
    ));
    const file = path.join(dir, 'broken.xml');
    fs.copyFileSync(path.join(__dirname, 'fixtures', 'veracode', 'malformed-report.xml'), file);
    const { view } = await screenWithFile('veracode', file);
    expect(view.report.problem).toMatch(/^Could not import report: .+/);
    expect(view.canOpen).toBe(false);
  });

  it('with nothing that matches the filters shows the kind\'s no-match message', async () => {
    settings.waltz = 'OSS finding';
    readers.waltz = fakeReader(0);
    const { view } = await screenWithFile('waltz');
    expect(view.report.problem).toBe('No components in this report matched your current filters.');
    expect(view.canOpen).toBe(false);
  });

  it('is cleared when the kind changes', async () => {
    const { screen } = await screenWithFile('waltz');
    const view = await screen.handle('kind', { kind: 'veracode' }) as StartScreenView;
    expect(view.kind).toBe('veracode');
    expect(view.report.path).toBeUndefined();
    await expect(screen.handle('kind', { kind: 'email' })).rejects.toMatchObject({ status: 400 });
  });
});

describe('what is missing around the import', () => {
  it('shows the Jira setup hint instead of Open when Jira is not configured', async () => {
    configured = false;
    settings.waltz = 'OSS finding';
    const { screen, view } = await screenWithFile('waltz');
    expect(view.jiraHint).toBe(buildJiraNotConfiguredMessage({ baseUrl: 'https://jira.example.com', token: undefined, authType: 'datacenter' }));
    expect(view.canOpen).toBe(false);
    await expect(screen.handle('open', {})).rejects.toMatchObject({ status: 409 });
  });

  it('shows the default-project notice with Open Setting and never writes that setting', async () => {
    settings.waltz = 'OSS finding';
    defaultProject = '';
    const empty = await screenWithFile('waltz');
    expect(empty.view.project.problem).toContain('ticketSidekick.jira.defaultProject');
    expect(empty.view.canOpen).toBe(false);

    defaultProject = 'not a key';
    expect((await empty.screen.view()).project.problem).toContain('is not a Jira project key');

    defaultProject = 'NOPE';
    projectFails = new JiraApiError('Not found', 404, 'https://jira.example.com/rest/api/2/project/NOPE');
    expect((await empty.screen.view()).project.problem).toContain('Jira has no project NOPE');

    await empty.screen.handle('open-setting', { setting: 'project' });
    expect(openedSettings).toEqual(['ticketSidekick.jira.defaultProject']);
    await expect(empty.screen.handle('open-setting', { setting: 'anything.else' })).rejects.toMatchObject({ status: 400 });
    expect(writes).toEqual([]);
  });

  it('says so when the workspace has no templates', async () => {
    templates = [];
    const { view } = await screenWithFile('waltz');
    expect(view.template.problem).toContain('.jira-templates.json');
    expect(view.canOpen).toBe(false);
  });

  it('opens the import board at once for a kind and file it was opened with, when the settings are complete', async () => {
    settings.waltz = 'OSS finding';
    const screen = new ImportStartScreen(deps());
    const file = report();
    screen.prefill({ kind: 'waltz', reportPath: file });
    expect(await screen.openIfReady()).toEqual({ opened: true });
    expect(opened).toEqual([{ kind: 'waltz', projectKey: 'PROJ', reportPath: file, templateName: 'OSS finding', issueType: 'Vulnerability' }]);
  });

  it('opens nothing for a kind and file when the template setting is empty or the file does not read, so the start screen shows them', async () => {
    const screen = new ImportStartScreen(deps());
    const file = report();
    screen.prefill({ kind: 'waltz', reportPath: file });
    expect(await screen.openIfReady()).toEqual({ opened: false });
    expect((await screen.view()).report.path).toBe(file);

    settings.waltz = 'OSS finding';
    readers.waltz = { ...fakeReader(), read: async () => { throw new Error('not an OSS report'); } };
    screen.prefill({ kind: 'waltz', reportPath: report('other.xlsx') });
    expect(await screen.openIfReady()).toEqual({ opened: false });
    expect(opened).toEqual([]);
  });

  it('starts with a kind and a file it was opened with', async () => {
    const screen = new ImportStartScreen(deps());
    const file = report();
    screen.prefill({ kind: 'waltz', reportPath: file });
    const view = await screen.view();
    expect(view).toMatchObject({ kind: 'waltz', report: { path: file, items: 3 } });
    screen.prefill({ kind: 'nonsense', reportPath: 'relative/path.xlsx' });
    expect((await screen.view()).report.path).toBe(file);
  });
});
