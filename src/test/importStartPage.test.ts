import { afterEach, describe, expect, it, vi } from 'vitest';
import { installFakePage, removeFakePage, settle, type FakePage } from './helpers/fakeDom';

// The import start screen's page: what the developer sees between the settings table and Open.
// A conditional child that is absent must leave nothing on the page (issue #131: the word "null").

let page: FakePage;

afterEach(() => removeFakePage());

function startView(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'veracode',
    kinds: [{ id: 'veracode', label: 'Veracode' }],
    report: { path: '/w/report.xml', fileName: 'report.xml', items: 3 },
    project: { key: 'PROJ' },
    template: { setting: 'Default', settingKey: 'ticketSidekick.veracode.template', name: 'Default' },
    issueType: { name: 'Task', fromTemplate: true },
    stored: false,
    canOpen: true,
    ...extra,
  };
}

async function open(view: Record<string, unknown>): Promise<void> {
  page = installFakePage({ kind: 'import-start', session: '', title: 'Jira Import Board' }, async () => view);
  vi.resetModules();
  await import('../../board-pages/import-start/page.js' as string);
  await settle();
}

describe('the import start screen page', () => {
  it('shows no stray "null" text without a stored import', async () => {
    await open(startView());
    expect(page.root.textContent).not.toContain('null');
    expect(page.root.textContent).not.toContain('undefined');
    expect(page.document.getElementById('open')).not.toBeNull();
  });

  it('still shows the stored-import notice and Start over when an import is stored', async () => {
    await open(startView({ stored: true }));
    expect(page.root.textContent).toContain('An import of this file in this project is stored.');
    expect(page.root.textContent).not.toContain('null');
    expect(page.document.getElementById('start-over')).not.toBeNull();
  });
});
