import { afterEach, describe, expect, it, vi } from 'vitest';
import { installFakePage, removeFakePage, settle, type FakeElement, type FakePage } from './helpers/fakeDom';

// The import start screen's page: what the developer sees between the settings table and Open.
// A conditional child that is absent must leave nothing on the page (issue #131: the word "null").
// The template is always a picker with a "Set as default" checkbox (issue #132).

let page: FakePage;

afterEach(() => removeFakePage());

const SETTING_KEY = 'ticketSidekick.veracode.template';

function startView(extra: Record<string, unknown> = {}, template: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'veracode',
    kinds: [{ id: 'veracode', label: 'Veracode' }, { id: 'waltz', label: 'Waltz OSS' }],
    report: { path: '/w/report.xml', fileName: 'report.xml', items: 3 },
    project: { key: 'PROJ' },
    template: { setting: 'Default', settingKey: SETTING_KEY, name: 'Default', hasDefault: true, options: ['Default', 'Other'], ...template },
    issueType: { name: 'Task', fromTemplate: true },
    stored: false,
    canOpen: true,
    ...extra,
  };
}

/** The view of a screen whose setting is empty and where nothing is picked yet. */
function askingView(): Record<string, unknown> {
  return startView({ canOpen: false }, {
    setting: '', name: undefined, hasDefault: false,
    askReason: `${SETTING_KEY} is empty. Pick the template for Veracode imports; keep Set as default ticked to save it to the setting.`,
  });
}

async function open(view: Record<string, unknown> | ((op: string, body: Record<string, unknown>) => Record<string, unknown>)): Promise<void> {
  const answer = typeof view === 'function' ? view : () => view;
  page = installFakePage({ kind: 'import-start', session: '', title: 'Jira Import Board' }, async (op, body) => answer(op, body));
  vi.resetModules();
  await import('../../board-pages/import-start/page.js' as string);
  await settle();
}

const byId = (id: string): FakeElement => {
  const el = page.document.getElementById(id);
  if (!el) throw new Error(`No element #${id} on the page.`);
  return el;
};
const templateRequests = () => page.posted.filter(m => m.op === 'template').map(m => m.body);

async function pick(name: string): Promise<void> {
  const select = byId('template');
  select.value = name;
  select.dispatch('change');
  await settle();
}

async function toggle(checked: boolean): Promise<void> {
  const box = byId('template-default');
  box.checked = checked;
  box.dispatch('change');
  await settle();
}

describe('the import start screen page', () => {
  it('shows no stray "null" text without a stored import', async () => {
    await open(startView());
    expect(page.root.textContent).not.toContain('null');
    expect(page.root.textContent).not.toContain('undefined');
    expect(page.document.getElementById('open')).not.toBeNull();
  });

  it('says what a stored import does, offers Open and Start over, and no longer calls it a stored import', async () => {
    await open(startView({ stored: true }));
    const text = page.root.textContent;
    expect(text).toContain('An import of this file in this project was started before.');
    expect(text).toContain('If its tab is still open, Open shows it as it is');
    expect(text).toContain('Start over discards the earlier import');
    expect(text).not.toContain('Open stored import');
    expect(text).not.toContain('null');
    expect(byId('open').textContent).toBe('Open');
    expect(page.document.getElementById('start-over')).not.toBeNull();
  });
});

describe('the template picker', () => {
  it('is a picker with the saved default selected and an unticked Set as default, naming the default and where it lives', async () => {
    await open(startView());
    const select = byId('template');
    expect(select.children.map(o => o.textContent)).toEqual(['Default', 'Other']);
    expect(select.children.find(o => o.selected)?.textContent).toBe('Default');
    expect(byId('template-default').checked).toBeFalsy();
    expect(page.root.textContent).toContain(`Default: Default (from ${SETTING_KEY})`);
    expect(page.root.textContent).not.toContain('This import only');
    expect(page.root.textContent).not.toContain('null');
    expect(page.root.textContent).not.toContain('undefined');
  });

  it('asks for a template and starts with Set as default ticked when the setting is empty or stale', async () => {
    await open(askingView());
    expect(page.root.textContent).toContain('keep Set as default ticked');
    const select = byId('template');
    expect(select.children[0].textContent).toBe('Choose a template…');
    expect(byId('template-default').checked).toBe(true);
  });

  it('posts the picked name with the checkbox value, ticked or not', async () => {
    await open(askingView());
    await pick('Other');
    expect(templateRequests()).toEqual([{ name: 'Other', setAsDefault: true }]);
  });

  it('posts a pick from a valid default without Set as default, and says the pick is for this import only', async () => {
    let current = 'Default';
    await open((op, body) => {
      if (op === 'template') current = String(body.name);
      return startView({}, { name: current });
    });
    await pick('Other');
    expect(templateRequests()).toEqual([{ name: 'Other', setAsDefault: false }]);
    expect(page.root.textContent).toContain('This import only.');
    expect(page.root.textContent).toContain(`Default: Default (from ${SETTING_KEY})`);
  });

  it('saves the current template when Set as default is ticked after a pick, and posts nothing when it is unticked', async () => {
    let current = 'Default';
    await open((op, body) => {
      if (op === 'template') current = String(body.name);
      return startView({}, { name: current });
    });
    await pick('Other');
    await toggle(true);
    expect(templateRequests()).toEqual([{ name: 'Other', setAsDefault: false }, { name: 'Other', setAsDefault: true }]);
    await toggle(false);
    expect(templateRequests()).toHaveLength(2);
  });

  it('posts nothing when Set as default is toggled before any template is picked, and a later pick sends the toggled value', async () => {
    await open(askingView());
    await toggle(false);
    expect(templateRequests()).toEqual([]);
    expect(page.root.textContent).not.toContain('Error');
    expect(byId('template-default').checked).toBeFalsy();
    await pick('Other');
    expect(templateRequests()).toEqual([{ name: 'Other', setAsDefault: false }]);
  });

  it('keeps Set as default ticked after the save that made the setting valid', async () => {
    let saved = false;
    await open((op, body) => {
      if (op === 'template' && body.setAsDefault === true) saved = true;
      return saved
        ? startView({}, { setting: 'Other', name: 'Other', hasDefault: true })
        : askingView();
    });
    await pick('Other');
    expect(byId('template-default').checked).toBe(true);
  });

  it('keeps keyboard focus on the checkbox when the page is drawn again', async () => {
    await open(startView());
    const box = byId('template-default');
    expect(box.id).toBe('template-default');
    box.focus();
    page.window.dispatch('focus');
    await settle();
    expect(page.document.activeElement?.id).toBe('template-default');
  });

  it('shows the problem and no picker when the templates cannot be read', async () => {
    await open(startView({ canOpen: false }, { name: undefined, options: undefined, hasDefault: false, problem: 'No templates in this workspace.' }));
    expect(page.root.textContent).toContain('No templates in this workspace.');
    expect(page.document.getElementById('template')).toBeNull();
    expect(page.document.getElementById('template-default')).toBeNull();
  });
});
