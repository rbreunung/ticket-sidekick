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
let listFails: Error | undefined;
let projectWrites: string[];
let nextFile: string | undefined;
let pickedFilters: string[];
let stored: Set<string>;
let discarded: string[];
let opened: ImportRecipe[];
let openedSettings: string[];
let readers: Partial<Record<ReportKind, ReportReader>>;
let nextEmails: string[] | undefined;
let unreadable: Set<string>;
let modelSettings: { email: string; review: string };
let available: Array<{ id: string; name: string; vendor: string; family: string }>;
let modelFails: Error | undefined;
let modelCalls: string[];

const fakeReader = (items = 3): ReportReader => ({
  read: async () => ({ items: Array.from({ length: items }, (_, i) => i), rawItems: [] }),
  noMatchMessage: 'No components in this report matched your current filters.',
  fileFilter: { label: 'OSS report', extensions: ['xlsx'] },
});

const client = {
  listProjects: async () => {
    if (listFails) throw listFails;
    return [{ id: '2', key: 'SEC', name: 'Security' }, { id: '1', key: 'PROJ', name: 'Sample Project' }];
  },
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
    writeDefaultProject: async key => { defaultProject = key; projectWrites.push(key); },
    templates: () => templates,
    reportReader: kind => readers[kind] ?? fakeReader(),
    pickReportFile: async (_kind, filter) => { pickedFilters.push(filter.label); return nextFile; },
    pickEmailFiles: async () => nextEmails,
    emailFiles: {
      checkCaps: async paths => (paths.length > 50 ? `Selected ${paths.length} files — the batch limit is 50.` : null),
      read: async filePath => { if (unreadable.has(path.basename(filePath))) throw new Error('not an email'); return {}; },
    },
    models: {
      list: async () => available,
      send: async id => { modelCalls.push(id); if (modelFails) throw modelFails; return 'ready'; },
    },
    modelSettings: {
      emailModel: () => modelSettings.email,
      reviewModel: () => modelSettings.review,
      writeEmailModel: async id => { modelSettings.email = id; },
    },
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
  settings = { veracode: '', waltz: '', email: '' };
  nextEmails = undefined;
  unreadable = new Set();
  modelSettings = { email: '', review: '' };
  available = [{ id: 'm1', name: 'Model One', vendor: 'copilot', family: 'one' }];
  modelFails = undefined;
  modelCalls = [];
  writes = [];
  templates = [{ name: 'OSS finding', issueType: 'Vulnerability' }, { name: 'Plain', issueType: undefined } as JiraTemplate];
  defaultProject = 'PROJ';
  configured = true;
  projectFails = undefined;
  listFails = undefined;
  projectWrites = [];
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
    await expect(screen.handle('kind', { kind: 'mail' })).rejects.toMatchObject({ status: 400 });
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

  it('asks for the project when the setting is empty, with Jira\'s projects as suggestions, saves it, and does not ask again', async () => {
    settings.waltz = 'OSS finding';
    defaultProject = '';
    const { screen, view } = await screenWithFile('waltz');
    expect(view.project.options).toEqual([{ key: 'PROJ', name: 'Sample Project' }, { key: 'SEC', name: 'Security' }]);
    expect(view.project.askReason).toContain('ticketSidekick.jira.defaultProject');
    expect(view.canOpen).toBe(false);
    expect(view.blocker).toBe('Type or choose a project.');

    const picked = await screen.handle('project', { key: 'sec' }) as StartScreenView;
    expect(projectWrites).toEqual(['SEC']);
    expect(picked.project).toEqual({ key: 'SEC' });
    expect(picked.canOpen).toBe(true);

    const next = (await screenWithFile('waltz', report('next.xlsx'))).view;
    expect(next.project).toEqual({ key: 'SEC' });
    expect(projectWrites).toHaveLength(1);
  });

  it('takes a typed key that is not in Jira\'s list once Jira finds the project, as a long list may be cut short', async () => {
    settings.waltz = 'OSS finding';
    defaultProject = '';
    const { screen } = await screenWithFile('waltz');
    const typed = await screen.handle('project', { key: 'OPS' }) as StartScreenView;
    expect(projectWrites).toEqual(['OPS']);
    expect(typed.project).toEqual({ key: 'OPS' });
  });

  it('asks for the project when the setting is not a key or names a project Jira does not have', async () => {
    settings.waltz = 'OSS finding';
    defaultProject = 'not a key';
    const { screen, view } = await screenWithFile('waltz');
    expect(view.project.askReason).toContain('is not a Jira project key');
    expect(view.project.options).toHaveLength(2);

    defaultProject = 'NOPE';
    projectFails = new JiraApiError('Not found', 404, 'https://jira.example.com/rest/api/2/project/NOPE');
    const unknown = await screen.view();
    expect(unknown.project.askReason).toContain('Jira has no project NOPE');
    expect(unknown.project.key).toBeUndefined();
  });

  it('refuses a typed key Jira does not have, or that is not a key, and writes nothing', async () => {
    defaultProject = '';
    const { screen } = await screenWithFile('waltz');
    projectFails = new JiraApiError('Not found', 404, 'https://jira.example.com/rest/api/2/project/OTHER');
    await expect(screen.handle('project', { key: 'OTHER' })).rejects.toMatchObject({ status: 400, message: expect.stringContaining('Jira has no project OTHER') });
    await expect(screen.handle('project', { key: 'not a key' })).rejects.toMatchObject({ status: 400 });
    await expect(screen.handle('project', { key: '' })).rejects.toMatchObject({ status: 400 });
    expect(projectWrites).toEqual([]);
  });

  it('still takes a typed key when Jira\'s project list cannot be read, and says the list is missing', async () => {
    settings.waltz = 'OSS finding';
    defaultProject = '';
    listFails = new Error('connect ETIMEDOUT');
    const { screen, view } = await screenWithFile('waltz');
    expect(view.project.options).toEqual([]);
    expect(view.project.listWarning).toContain('connect ETIMEDOUT');
    expect(view.canOpen).toBe(false);

    await screen.handle('open-setting', { setting: 'project' });
    expect(openedSettings).toEqual(['ticketSidekick.jira.defaultProject']);
    await expect(screen.handle('open-setting', { setting: 'anything.else' })).rejects.toMatchObject({ status: 400 });

    const typed = await screen.handle('project', { key: 'PROJ' }) as StartScreenView;
    expect(projectWrites).toEqual(['PROJ']);
    expect(typed.canOpen).toBe(true);
  });

  it('shows only the notice with Open Setting while Jira is not set up', async () => {
    configured = false;
    defaultProject = '';
    const { view } = await screenWithFile('waltz');
    expect(view.project.problem).toContain('ticketSidekick.jira.defaultProject');
    expect(view.project.askReason).toBeUndefined();
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

describe('an email import', () => {
  async function emailScreen(names: string[]): Promise<{ screen: ImportStartScreen; view: StartScreenView }> {
    settings.email = 'OSS finding';
    const screen = new ImportStartScreen(deps());
    await screen.handle('kind', { kind: 'email' });
    nextEmails = names.map(n => report(n));
    const view = await screen.handle('pick-file', {}) as StartScreenView;
    return { screen, view };
  }

  it('takes several files and leaves out the ones that do not read', async () => {
    unreadable.add('b.eml');
    const { screen, view } = await emailScreen(['c.eml', 'a.eml', 'b.eml']);
    expect(view.report.fileName).toBe('3 emails');
    expect(view.report.items).toBe(2);
    expect(view.report.skipped).toEqual(['b.eml: not an email']);
    expect(view.canOpen).toBe(true);
    await screen.handle('open', {});
    expect(opened[0].kind).toBe('email');
    expect(opened[0].reportPaths!.map(p => path.basename(p))).toEqual(['a.eml', 'b.eml', 'c.eml']);
  });

  it('refuses more than 50 files before reading any', async () => {
    const { view } = await emailScreen(Array.from({ length: 51 }, (_, i) => `m${i}.eml`));
    expect(view.report.problem).toMatch(/the batch limit is 50/);
    expect(view.canOpen).toBe(false);
  });

  it('continues the same import when the same files are chosen in another order', async () => {
    const { screen } = await emailScreen(['a.eml', 'b.eml']);
    await screen.handle('open', {});
    nextEmails = [path.join(dir, 'b.eml'), path.join(dir, 'a.eml')];
    const again = await screen.handle('pick-file', {}) as StartScreenView;
    expect(again.stored).toBe(true);
  });

  it('asks for the email template once and saves it', async () => {
    const screen = new ImportStartScreen(deps());
    await screen.handle('kind', { kind: 'email' });
    nextEmails = [report('a.eml')];
    const view = await screen.handle('pick-file', {}) as StartScreenView;
    expect(view.template.askReason).toMatch(/ticketSidekick\.email\.template is empty/);
    await screen.handle('template', { name: 'OSS finding' });
    expect(writes).toEqual([['email', 'OSS finding']]);
  });
});

describe('the model for the email check', () => {
  async function emailView(): Promise<{ screen: ImportStartScreen; view: StartScreenView }> {
    const screen = new ImportStartScreen(deps());
    const view = await screen.handle('kind', { kind: 'email' }) as StartScreenView;
    return { screen, view };
  }

  it('offers the available models when no model is set, without calling one', async () => {
    const { view } = await emailView();
    expect(view.emailModel).toEqual({ settingKey: 'ticketSidekick.email.checkModel', options: [{ id: 'm1', label: 'Model One (copilot)' }] });
    expect(modelCalls).toEqual([]);
  });

  it('shows the review model as in use when the email setting is empty', async () => {
    modelSettings.review = 'm1';
    const { view } = await emailView();
    expect(view.emailModel!.inUse).toEqual({ id: 'm1', label: 'Model One (copilot)', source: 'review' });
  });

  it('saves a picked model and shows that it answered', async () => {
    const { screen } = await emailView();
    const view = await screen.handle('model', { id: 'm1' }) as StartScreenView;
    expect(modelSettings.email).toBe('m1');
    expect(modelCalls).toEqual(['m1']);
    expect(view.emailModel!.check).toEqual({ ok: true, message: 'The model answered.' });
  });

  it('keeps the pick and shows why the model did not answer', async () => {
    modelFails = new Error('Extension is not allowed to use language models');
    const { screen } = await emailView();
    const view = await screen.handle('model', { id: 'm1' }) as StartScreenView;
    expect(modelSettings.email).toBe('m1');
    expect(view.emailModel!.check).toEqual({ ok: false, message: 'The model did not answer: Extension is not allowed to use language models' });
  });

  it('says so when no model is available', async () => {
    available = [];
    const { view } = await emailView();
    expect(view.emailModel!.listProblem).toMatch(/No language model is available/);
    expect(view.emailModel!.options).toBeUndefined();
  });

  it('refuses a model that is not available and is not shown for the other kinds', async () => {
    const { screen } = await emailView();
    await expect(screen.handle('model', { id: 'other' })).rejects.toMatchObject({ status: 400 });
    const veracode = await screen.handle('kind', { kind: 'veracode' }) as StartScreenView;
    expect(veracode.emailModel).toBeUndefined();
  });
});
