import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { importKind, type ImportView, type ImportWorking } from '../boards/import/kind';
import { importJiraDeps } from '../boards/import/jiraDeps';
import { createEmailDescriptor } from '../imports/email';
import type { ImportData, ImportDeps } from '../boards/import/read';
import { importSessionId, withReportPath, type ImportRecipe } from '../boards/import/recipe';
import { createVeracodeDescriptor } from '../imports/veracode';
import { createWaltzDescriptor } from '../imports/waltz';
import type { JiraIssue, JiraSearchResult } from '../jira/IJiraClient';
import { registerKind, type BoardKind } from '../sessions/boardKind';
import { SessionManager } from '../sessions/sessionManager';
import { SessionStore } from '../sessions/sessionStore';
import type { Session } from '../sessions/sessionTypes';
import { sanitizeComponentLabel } from '../utils/waltzReport';
import { ACCEPTED_FILE_NAME } from '../utils/waltzAccepted';
import { MockJiraClient } from './mocks/MockJiraClient';

// The import board for a Veracode or Waltz report: it reads the report and Jira, shows one tab per
// group, and after a restart or another change keeps the developer's unfinished choices on show
// until they press Refresh.

interface Ticket {
  labels: string[];
  summary?: string;
  status?: string;
  resolved?: boolean;
  updated: string;
  description?: string;
}

class FakeJira extends MockJiraClient {
  tickets: Record<string, Ticket> = {};
  failDedup = false;
  failStale = false;
  unreadable = new Set<string>();

  private issue(key: string): JiraIssue {
    const t = this.tickets[key];
    return {
      id: key, key,
      fields: {
        labels: t.labels, summary: t.summary ?? `Ticket ${key}`, status: { name: t.status ?? 'Open' },
        resolution: t.resolved ? { name: 'Done' } : null, created: '2026-01-01T09:00:00.000+0000', duedate: null,
        updated: t.updated, issuetype: { name: 'Bug' }, fixVersions: [], description: t.description ?? '',
      },
    } as unknown as JiraIssue;
  }

  override async searchJql(jql: string): Promise<JiraSearchResult> {
    const all = Object.keys(this.tickets);
    let keys: string[] = [];
    if (jql.includes('labels in (')) {
      if (this.failDedup) throw Object.assign(new Error('Jira answered 503'), { status: 503 });
      keys = all.filter(k => this.tickets[k].labels.some(l => jql.includes(`"${l}"`)));
    } else if (jql.includes('resolution is EMPTY AND labels =')) {
      if (this.failStale) throw Object.assign(new Error('Jira answered 503'), { status: 503 });
      const marker = /labels = "([^"]+)"/.exec(jql)![1];
      keys = all.filter(k => !this.tickets[k].resolved && this.tickets[k].labels.includes(marker));
    } else if (jql.startsWith('key in (')) {
      const wanted = /key in \(([^)]*)\)/.exec(jql)![1].split(',').map(s => s.trim());
      keys = all.filter(k => wanted.includes(k));
    }
    const issues = keys.map(k => this.issue(k));
    return { issues, total: issues.length, isLast: true };
  }

  override async getIssue(key: string): Promise<JiraIssue> {
    if (this.unreadable.has(key) || !this.tickets[key]) throw Object.assign(new Error('Jira answered 500'), { status: 500 });
    return this.issue(key);
  }

  override async getProject(): Promise<never> {
    return { key: 'PROJ', name: 'Project', issueTypes: [{ name: 'Bug', subtask: false }], versions: [{ name: '1.0', releaseDate: '2026-12-01', released: false }] } as never;
  }
}

interface Flaw { id: string; file: string; cwe?: string; line?: number }

function veracodeXml(flaws: Flaw[]): string {
  const blocks = flaws.map(f => `
  <severity level="4">
    <category categoryid="18" categoryname="Credentials Management" pcirelated="true">
      <desc><para text="Hard-coded credentials."/></desc>
      <recommendations><para text="Use a secrets manager."/></recommendations>
      <cwe cweid="${f.cwe ?? '798'}" cwename="Use of Hard-coded Credentials">
        <description><para text="Risky."/></description>
        <staticflaws>
          <flaw severity="4" categoryname="Credentials Management" count="1" issueid="${f.id}" module="App.war"
                type="Hard-coded Password" description="A hard-coded password in ${f.file}."
                cweid="${f.cwe ?? '798'}" remediationeffort="2" exploitLevel="3" categoryid="18"
                date_first_occurrence="2026-04-20T14:00:00.000-0000" remediation_status="New"
                sourcefile="${f.file}" line="${f.line ?? 10}" sourcefilepath="com/example/" mitigation_status="none"/>
        </staticflaws>
      </cwe>
    </category>
  </severity>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<detailedreport xmlns="https://analysiscenter.veracode.com/schema/2.0/detailedreport" report_format_version="1.5" app_name="App">${blocks}
</detailedreport>`;
}

let dir: string;
let jira: FakeJira;
let deps: ImportDeps;
let clock: number;

const MB = 20 * 1024 * 1024;

beforeEach(async () => {
  dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ts-import-board-'));
  jira = new FakeJira();
  clock = 1_000;
  const veracode = createVeracodeDescriptor({
    filter: () => ({ minSeverity: 3, includeStatuses: ['New', 'Open', 'Reopened'], maxReportBytes: MB }),
    slaDays: () => undefined,
  }, { reviewColumns: [] });
  const waltz = createWaltzDescriptor({
    filter: () => ({ minVulnRating: 'High', includeRemediationActions: ['', 'Remediate'], maxReportBytes: MB }),
    minVulnRating: () => 'High',
    workspaceRoot: () => dir,
  }, { reviewColumns: [] });
  deps = importJiraDeps({
    getJira: async () => ({ configured: true, client: jira, config: { baseUrl: 'https://jira.example.com' } }) as never,
    workspaceFolder: () => dir,
    descriptors: { veracode, waltz, email: createEmailDescriptor({ deleteEmlAfterImport: () => false, maxBatchBytes: () => 1024 * 1024 }) },
    now: () => clock,
  });
});

afterEach(async () => {
  await fs.promises.rm(dir, { recursive: true, force: true });
});

function writeVeracode(flaws: Flaw[], name = 'report.xml'): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, veracodeXml(flaws));
  return file;
}

function copyWaltz(name = 'oss.xlsx'): string {
  const file = path.join(dir, name);
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'waltz', 'sample-report.xlsx'), file);
  return file;
}

function recipe(kind: 'veracode' | 'waltz', reportPath: string): ImportRecipe {
  return { kind, projectKey: 'PROJ', reportPath, templateName: 'Security bug', issueType: 'Bug' };
}

type ImportSession = Session<ImportRecipe, ImportData, ImportWorking>;

async function open(r: ImportRecipe): Promise<ImportSession> {
  const validated = await importKind.validate(r, deps);
  if (!validated.ok) throw new Error(validated.reason);
  return {
    id: importSessionId(r), kind: 'import', formatVersion: importKind.formatVersion, revision: 1, createdAt: 0, lastUsedAt: 0,
    recipe: validated.recipe, derived: await importKind.read(validated.recipe, deps), working: importKind.initialWorking(validated.recipe), conflicts: [],
  };
}

async function check(session: ImportSession, mode: 'background' | 'refresh' = 'background'): Promise<ImportSession> {
  const fresh = await importKind.read(session.recipe, deps);
  const merged = importKind.reconcile(session, fresh, mode);
  return { ...session, derived: merged.derived, working: merged.working };
}

function withWorking(session: ImportSession, change: (w: ImportWorking) => ImportWorking): ImportSession {
  return { ...session, working: change(session.working) };
}

function act(session: ImportSession, action: unknown): ImportSession {
  const reduced = importKind.reduce(session, action as never);
  if (!reduced.ok) throw new Error(reduced.reason);
  return { ...session, working: reduced.working };
}

const view = (session: ImportSession): ImportView => importKind.view(session);
const tab = (v: ImportView, id: string) => v.tabs.find(t => t.id === id)!;
const counts = (v: ImportView) => Object.fromEntries(v.tabs.map(t => [t.id, t.count]));
/** The row key a New or Already-ticketed Veracode row is identified by: its flaw ids. */
const key = (...ids: string[]) => [...ids].sort().join('\n');

const veracodeTicket = (...ids: string[]): Ticket => ({ labels: ['veracode', ...ids.map(id => `veracode-issue-${id}`)], updated: 't1' });

describe('opening an import', () => {
  it('shows a Veracode report with new and matched findings as tabs with their counts, in report order', async () => {
    const ids = ['101', '102', '103', '104', '105', '106', '107', '108'];
    const file = writeVeracode(ids.map((id, n) => ({ id, file: `File${n}.java` })));
    jira.tickets = {
      'PROJ-1': veracodeTicket('102'), 'PROJ-2': veracodeTicket('105'), 'PROJ-3': veracodeTicket('108'),
      // An open ticket whose flaw is no longer in the report.
      'PROJ-9': veracodeTicket('999'),
    };

    const session = await open(recipe('veracode', file));
    const v = view(session);

    expect(counts(v)).toEqual({ new: 5, ticketed: 3, stale: 1 });
    expect(v.tab).toBe('new');
    expect(v.openingTab).toBe('new');
    expect(v.new!.rows.map(r => r.ref)).toEqual(['Flaw 101', 'Flaw 103', 'Flaw 104', 'Flaw 106', 'Flaw 107']);
    // Only the tab in view carries its rows.
    expect(v.ticketed).toBeUndefined();
    const ticketed = view(act(session, { type: 'tab', tab: 'ticketed' }));
    expect(ticketed.ticketed!.rows.map(r => r.ticket)).toEqual(['PROJ-1', 'PROJ-2', 'PROJ-3']);
    const stale = view(act(session, { type: 'tab', tab: 'stale' }));
    expect(stale.stale!.rows.map(r => r.key)).toEqual(['PROJ-9']);
    expect(v.finished).toBe(false);
  });

  it('reads what the export needs with the review: the versions and the matched tickets', async () => {
    const file = writeVeracode([{ id: '101', file: 'A.java' }, { id: '102', file: 'B.java' }]);
    jira.tickets = { 'PROJ-1': veracodeTicket('102') };
    const session = await open(recipe('veracode', file));
    expect(session.derived.data.export.versions).toEqual([{ name: '1.0', releaseDate: '2026-12-01', released: false }]);
    expect(session.derived.data.export.tickets.map(t => t.key)).toEqual(['PROJ-1']);
    expect(session.derived.data.updated).toEqual({ 'PROJ-1': 't1' });
  });

  it('opens a report with only matched findings on Already ticketed, and New shows 0 with its empty message', async () => {
    // Two flaws in one file with the same CWE fold into one row; its ticket records only the first.
    const file = writeVeracode([{ id: '201', file: 'Same.java' }, { id: '202', file: 'Same.java', line: 20 }]);
    jira.tickets = { 'PROJ-1': veracodeTicket('201') };
    const v = view(await open(recipe('veracode', file)));
    expect(v.openingTab).toBe('ticketed');
    expect(v.tab).toBe('ticketed');
    expect(tab(v, 'new')).toMatchObject({ count: 0 });
    expect(tab(v, 'new').empty).toMatch(/no new/i);
    expect(v.ticketed!.rows[0]).toMatchObject({ ticket: 'PROJ-1', needsDecision: true });
  });

  it('says there is nothing left to do when no tab has work', async () => {
    const file = writeVeracode([{ id: '301', file: 'A.java' }]);
    jira.tickets = { 'PROJ-1': veracodeTicket('301') };
    const v = view(await open(recipe('veracode', file)));
    expect(v.finished).toBe(true);
  });

  it('refuses a check whose dedup search failed, instead of showing matched findings as New', async () => {
    const file = writeVeracode([{ id: '101', file: 'A.java' }, { id: '102', file: 'B.java' }]);
    jira.tickets = { 'PROJ-1': veracodeTicket('102') };
    const session = await open(recipe('veracode', file));
    jira.failDedup = true;
    await expect(importKind.read(session.recipe, deps)).rejects.toThrow(/already-ticketed|ticket/i);
  });

  it('shows Stale as unavailable when its search failed, and New and Already ticketed as usual', async () => {
    const file = writeVeracode([{ id: '101', file: 'A.java' }, { id: '102', file: 'B.java' }]);
    jira.tickets = { 'PROJ-1': veracodeTicket('102') };
    jira.failStale = true;
    const v = view(await open(recipe('veracode', file)));
    expect(tab(v, 'stale').unavailable).toMatch(/stale/i);
    expect(tab(v, 'new')).toMatchObject({ count: 1 });
    expect(tab(v, 'new').unavailable).toBeUndefined();
    expect(tab(v, 'ticketed')).toMatchObject({ count: 1 });
    expect(tab(v, 'ticketed').unavailable).toBeUndefined();
  });

  it('opens with one unreadable target description: that row is not compared and the tab warns', async () => {
    const file = copyWaltz();
    jira.tickets = {
      'PROJ-1': { labels: ['oss-dependency', sanitizeComponentLabel('example-lib:1.2.3')], updated: 't1' },
      'PROJ-2': { labels: ['oss-dependency', sanitizeComponentLabel('example-io:4.5.0')], updated: 't1' },
    };
    jira.unreadable.add('PROJ-1');
    const session = await open(recipe('waltz', file));
    const v = view(act(session, { type: 'tab', tab: 'ticketed' }));
    expect(tab(v, 'ticketed').count).toBe(2);
    expect(tab(v, 'ticketed').warning).toMatch(/1 ticket/);
    expect(session.derived.data.descriptionsUnread).toBe(1);
  });

  it('offers the Accepted tab for Waltz only', async () => {
    fs.writeFileSync(path.join(dir, ACCEPTED_FILE_NAME), JSON.stringify({ accepted: [{ component: 'example-lib', version: '1.2.3', reason: 'not shipped' }] }));
    const waltz = view(await open(recipe('waltz', copyWaltz())));
    expect(waltz.tabs.map(t => t.id)).toEqual(['new', 'ticketed', 'stale', 'accepted']);
    expect(tab(waltz, 'accepted').count).toBe(1);
    expect(waltz.new!.rows.map(r => r.ref).sort()).toEqual(['example-http:3.3.3', 'example-io:4.5.0']);
    const veracode = view(await open(recipe('veracode', writeVeracode([{ id: '1', file: 'A.java' }]))));
    expect(veracode.tabs.map(t => t.id)).toEqual(['new', 'ticketed', 'stale']);
  });
});

describe('the recipe', () => {
  it('is rebuilt after an update from its kind and path, keeping the template and issue type', async () => {
    const file = writeVeracode([{ id: '1', file: 'A.java' }]);
    const checked = await importKind.revalidate!({ ...recipe('veracode', file), templateName: 'Old template', issueType: 'Vulnerability' }, deps);
    expect(checked).toEqual({ ok: true, recipe: { ...recipe('veracode', file), templateName: 'Old template', issueType: 'Vulnerability' } });
    expect((await importKind.revalidate!({ ...recipe('veracode', file), kind: 'mail' as never }, deps)).ok).toBe(false);
    expect((await importKind.revalidate!({ ...recipe('veracode', file), reportPath: 'relative.xml' }, deps)).ok).toBe(false);
  });

  it('gives the same session id as the start screen', () => {
    const r = recipe('veracode', path.join(dir, 'report.xml'));
    expect(importKind.sourceKey(r)).toBe(importKind.sourceKey({ ...r, templateName: 'Another' }));
  });
});

describe('a check after a restart or another change', () => {
  it('marks New out of date when a ticket appears for a New row the board never recorded, and Refresh moves the row and names the dropped choice', async () => {
    const file = writeVeracode([{ id: '101', file: 'A.java' }, { id: '102', file: 'B.java' }, { id: '103', file: 'C.java' }]);
    let session = await open(recipe('veracode', file));
    session = withWorking(session, w => ({ ...w, choices: { ...w.choices, excluded: [key('102')] } }));
    // Jira created a ticket for flaw 102, but the board crashed before it saved the create.
    jira.tickets = { 'PROJ-7': veracodeTicket('102') };

    session = await check(session);
    let v = view(session);
    expect(tab(v, 'new')).toMatchObject({ outOfDate: true, count: 3 });
    expect(v.new!.rows.map(r => r.ref)).toEqual(['Flaw 101', 'Flaw 102', 'Flaw 103']);

    session = await check(session, 'refresh');
    v = view(session);
    expect(tab(v, 'new')).toMatchObject({ outOfDate: false, count: 2 });
    expect(tab(v, 'ticketed').count).toBe(1);
    expect(v.dropped.join(' ')).toMatch(/Flaw 102/);
    expect(session.working.choices.excluded).toEqual([]);
  });

  it('sets no mark for the creates the board recorded itself', async () => {
    const ids = ['1', '2', '3', '4', '5', '6', '7'];
    const file = writeVeracode(ids.map(id => ({ id, file: `F${id}.java` })));
    let session = await open(recipe('veracode', file));
    // An Apply creating all 7 was interrupted after 4; each create was recorded as it finished.
    const created = ids.slice(0, 4).map((id, n) => ({ dedupKeys: [id], key: `PROJ-${10 + n}` }));
    for (const c of created) jira.tickets[c.key] = veracodeTicket(...c.dedupKeys);
    session = withWorking(session, w => ({
      ...w, choices: { ...w.choices, excluded: [key('7')] }, writes: { ...w.writes, created },
    }));

    session = await check(session);
    const v = view(session);
    expect(tab(v, 'new')).toMatchObject({ outOfDate: false });
    expect(tab(v, 'ticketed')).toMatchObject({ outOfDate: false, count: 4 });
    expect(v.new!.rows.map(r => r.ref)).toEqual(['Flaw 5', 'Flaw 6', 'Flaw 7']);
    expect(session.working.choices.excluded).toEqual([key('7')]);
  });

  it('lets a tab without unfinished choices take its changed rows at once', async () => {
    const file = writeVeracode([{ id: '101', file: 'A.java' }, { id: '201', file: 'Same.java' }, { id: '202', file: 'Same.java', line: 20 }]);
    jira.tickets = { 'PROJ-1': veracodeTicket('201') };
    let session = await open(recipe('veracode', file));
    session = withWorking(session, w => ({ ...w, choices: { ...w.choices, excluded: [key('101')] } }));
    // A ticket merge elsewhere recorded flaw 202 on PROJ-1 too.
    jira.tickets['PROJ-1'] = { ...veracodeTicket('201', '202'), updated: 't2' };

    session = await check(session);
    const v = view(act(session, { type: 'tab', tab: 'ticketed' }));
    expect(tab(v, 'ticketed').outOfDate).toBe(false);
    expect(v.ticketed!.rows[0]).toMatchObject({ ticket: 'PROJ-1', needsDecision: false });
    expect(tab(v, 'new').outOfDate).toBe(false);
  });

  it('does not count a ticket the board rewrote itself, but marks one someone else changed', async () => {
    const file = writeVeracode([{ id: '201', file: 'Same.java' }, { id: '202', file: 'Same.java', line: 20 }, { id: '301', file: 'Other.java' }, { id: '302', file: 'Other.java', line: 30 }]);
    jira.tickets = { 'PROJ-1': veracodeTicket('201'), 'PROJ-2': veracodeTicket('301') };
    let session = await open(recipe('veracode', file));
    session = withWorking(session, w => ({ ...w, choices: { ...w.choices, actions: { [key('301', '302')]: 'leave' } } }));
    // The board rewrote PROJ-1 and recorded Jira's updated time after the write.
    jira.tickets['PROJ-1'] = { ...veracodeTicket('201', '202'), updated: 't2' };
    session = withWorking(session, w => ({ ...w, writes: { ...w.writes, tickets: { 'PROJ-1': { updated: 't2' } } } }));
    expect(tab(view(await check(session)), 'ticketed').outOfDate).toBe(false);

    // Someone else then changes PROJ-2 while its row holds a choice.
    jira.tickets['PROJ-2'] = { ...veracodeTicket('301', '302'), updated: 't3' };
    session = await check(session);
    expect(tab(view(session), 'ticketed').outOfDate).toBe(true);
    session = await check(session, 'refresh');
    expect(session.working.choices.actions).toEqual({ [key('301', '302')]: 'leave' });
    expect(tab(view(session), 'ticketed').outOfDate).toBe(false);
  });

  it('keeps a merge whose rows still exist when Refresh follows a change of the accepted list, and numbers the rows anew', async () => {
    const listFile = path.join(dir, ACCEPTED_FILE_NAME);
    fs.writeFileSync(listFile, JSON.stringify({ accepted: [{ component: 'example-http', version: '3.3.3' }] }));
    let session = await open(recipe('waltz', copyWaltz()));
    const before = session.derived.data.review.allRows.filter(r => r.existingTicketKey === null);
    expect(before.map(r => (r as { nameVersion: string }).nameVersion).sort()).toEqual(['example-io:4.5.0', 'example-lib:1.2.3']);
    const merge = [sanitizeComponentLabel('example-io:4.5.0'), sanitizeComponentLabel('example-lib:1.2.3')];
    session = withWorking(session, w => ({ ...w, choices: { ...w.choices, merges: [merge] } }));

    // The developer unaccepts the component: it comes back onto New.
    fs.writeFileSync(listFile, JSON.stringify({ accepted: [] }));
    session = await check(session);
    expect(tab(view(session), 'new')).toMatchObject({ outOfDate: true, count: 2 });

    session = await check(session, 'refresh');
    const v = view(session);
    expect(tab(v, 'new')).toMatchObject({ outOfDate: false, count: 3 });
    expect(session.working.choices.merges).toEqual([merge]);
    expect(v.dropped).toEqual([]);
    expect(v.new!.rows.map(r => r.id)).toEqual(['1', '2', '3']);
    expect(tab(v, 'accepted').count).toBe(0);
  });
});

describe('a report file that is gone', () => {
  let manager: SessionManager;
  let storeDir: string;

  /** The import kind with a stand-in write, so the write guard of the session layer can be seen. */
  const writable = {
    ...importKind,
    plan: () => ({ ok: true as const, plan: { title: 'Test write', lines: [{ target: 'PROJ', change: 'nothing' }], risky: false, payload: null } }),
    apply: async (s: ImportSession) => ({ results: [], derived: s.derived, working: s.working }),
  } as BoardKind<ImportRecipe, ImportData, ImportWorking, unknown, ImportView, ImportDeps>;

  const makeManager = () => new SessionManager({
    store: new SessionStore(storeDir), kinds: [registerKind(writable, () => deps)], now: () => clock,
    confirm: async () => true, saveFile: async () => true,
  });

  async function settled(m: SessionManager, id: string, minTick = 0) {
    let state = await m.state('import', id);
    while (state.status === 'building' || state.status === 'checking' || state.tick < minTick) state = await m.state('import', id, state.tick, 2000);
    return state;
  }

  beforeEach(async () => {
    storeDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ts-import-store-'));
    manager = makeManager();
  });
  afterEach(async () => {
    await fs.promises.rm(storeDir, { recursive: true, force: true });
  });

  it('blocks writes and keeps the stored rows; picking the file at its new place keeps the choices and the new path finds the same session', async () => {
    const file = writeVeracode([{ id: '101', file: 'A.java' }, { id: '102', file: 'B.java' }]);
    const opened = await manager.open('import', recipe('veracode', file));
    if (!opened.ok) throw new Error(opened.reason);
    let state = await settled(manager, opened.id);
    state = await manager.action('import', opened.id, state.revision, { type: 'tab', tab: 'stale' });

    const moved = path.join(dir, 'moved', 'report.xml');
    fs.mkdirSync(path.dirname(moved));
    fs.renameSync(file, moved);
    // A restart: the stored board is shown and checked in the background.
    manager = makeManager();
    state = await settled(manager, opened.id, 3);
    expect(state.writesBlocked).toBe(true);
    expect(state.errorCode).toBe('report-not-found');
    expect(state.error).toContain(file);
    expect((state.view as ImportView).tab).toBe('stale');
    await expect(manager.preview('import', opened.id, state.revision, { type: 'write' })).rejects.toThrow(/check against the sources failed/);

    const session = (await manager.read('import', opened.id)) as ImportSession;
    const relocated = await manager.relocate('import', opened.id, withReportPath(session.recipe, moved));
    expect(relocated.id).toBe(importSessionId({ ...session.recipe, reportPath: moved }));
    expect(relocated.state.writesBlocked).toBe(false);
    expect((relocated.state.view as ImportView).tab).toBe('stale');
    await expect(manager.state('import', opened.id)).rejects.toThrow(/no longer exists/);
    await expect(manager.preview('import', relocated.id, relocated.state.revision, { type: 'write' })).resolves.toMatchObject({ title: 'Test write' });

    const again = await manager.open('import', { ...recipe('veracode', moved), templateName: 'Another' });
    expect(again).toMatchObject({ ok: true, id: relocated.id });
  });

  it('refuses a file whose path another session already uses, naming that session', async () => {
    const first = writeVeracode([{ id: '1', file: 'A.java' }], 'first.xml');
    const second = writeVeracode([{ id: '2', file: 'B.java' }], 'second.xml');
    const a = await manager.open('import', recipe('veracode', first));
    const b = await manager.open('import', recipe('veracode', second));
    if (!a.ok || !b.ok) throw new Error('not opened');
    await settled(manager, a.id);
    await settled(manager, b.id);
    await expect(manager.relocate('import', a.id, recipe('veracode', second))).rejects.toThrow(/second\.xml/);
    expect((await manager.state('import', a.id)).id).toBe(a.id);
  });
});
