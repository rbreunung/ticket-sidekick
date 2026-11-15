import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { importKind, type ImportView, type ImportWorking } from '../boards/import/kind';
import { importJiraDeps } from '../boards/import/jiraDeps';
import type { ImportData, ImportDeps } from '../boards/import/read';
import { importSessionId, type ImportRecipe } from '../boards/import/recipe';
import { createVeracodeDescriptor } from '../imports/veracode';
import { createWaltzDescriptor } from '../imports/waltz';
import type { JiraIssue, JiraSearchResult } from '../jira/IJiraClient';
import type { Session, WritePlan } from '../sessions/sessionTypes';
import { sanitizeComponentLabel } from '../utils/waltzReport';
import { ACCEPTED_FILE_NAME } from '../utils/waltzAccepted';
import { MockJiraClient } from './mocks/MockJiraClient';

// The import board's accepted list (Waltz) and its reload: accept and unaccept CVEs and components,
// and read the report again, each through a preview and Apply that never asks the native
// confirmation, because none of them writes to Jira.

interface Ticket { labels: string[]; summary?: string; status?: string; resolved?: boolean; updated: string; description?: string }

class FakeJira extends MockJiraClient {
  tickets: Record<string, Ticket> = {};

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
      keys = all.filter(k => this.tickets[k].labels.some(l => jql.includes(`"${l}"`)));
    } else if (jql.includes('resolution is EMPTY AND labels =')) {
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
    if (!this.tickets[key]) throw Object.assign(new Error('Jira answered 404'), { status: 404 });
    return this.issue(key);
  }

  override async getProject(): Promise<never> {
    return { key: 'PROJ', name: 'Project', issueTypes: [{ name: 'Bug', subtask: false }], versions: [] } as never;
  }
}

interface Flaw { id: string; file: string }

function veracodeXml(flaws: Flaw[]): string {
  const blocks = flaws.map(f => `
  <severity level="4">
    <category categoryid="18" categoryname="Credentials Management" pcirelated="true">
      <desc><para text="Hard-coded credentials."/></desc>
      <recommendations><para text="Use a secrets manager."/></recommendations>
      <cwe cweid="798" cwename="Use of Hard-coded Credentials">
        <description><para text="Risky."/></description>
        <staticflaws>
          <flaw severity="4" categoryname="Credentials Management" count="1" issueid="${f.id}" module="App.war"
                type="Hard-coded Password" description="A hard-coded password in ${f.file}."
                cweid="798" remediationeffort="2" exploitLevel="3" categoryid="18"
                date_first_occurrence="2026-04-20T14:00:00.000-0000" remediation_status="New"
                sourcefile="${f.file}" line="10" sourcefilepath="com/example/" mitigation_status="none"/>
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
const MB = 20 * 1024 * 1024;

beforeEach(async () => {
  dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ts-import-accepted-'));
  jira = new FakeJira();
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
    descriptors: { veracode, waltz },
    now: () => 1_000,
  });
});

afterEach(async () => {
  await fs.promises.rm(dir, { recursive: true, force: true });
});

type ImportSession = Session<ImportRecipe, ImportData, ImportWorking>;

const listFile = () => path.join(dir, ACCEPTED_FILE_NAME);
const writeList = (accepted: unknown[]) => fs.writeFileSync(listFile(), JSON.stringify({ accepted }));
const readList = () => JSON.parse(fs.readFileSync(listFile(), 'utf8')).accepted as unknown[];

function copyWaltz(): string {
  const file = path.join(dir, 'oss.xlsx');
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'waltz', 'sample-report.xlsx'), file);
  return file;
}

function writeVeracode(flaws: Flaw[]): string {
  const file = path.join(dir, 'report.xml');
  fs.writeFileSync(file, veracodeXml(flaws));
  return file;
}

function recipe(kind: 'veracode' | 'waltz', reportPath: string): ImportRecipe {
  return { kind, projectKey: 'PROJ', reportPath, templateName: 'Security bug', issueType: 'Bug' };
}

async function open(r: ImportRecipe): Promise<ImportSession> {
  const validated = await importKind.validate(r, deps);
  if (!validated.ok) throw new Error(validated.reason);
  return {
    id: importSessionId(r), kind: 'import', formatVersion: importKind.formatVersion, revision: 1, createdAt: 0, lastUsedAt: 0,
    recipe: validated.recipe, derived: await importKind.read(validated.recipe, deps), working: importKind.initialWorking(validated.recipe), conflicts: [],
  };
}

async function check(session: ImportSession, mode: 'background' | 'refresh'): Promise<ImportSession> {
  const fresh = await importKind.read(session.recipe, deps);
  const merged = importKind.reconcile(session, fresh, mode);
  return { ...session, derived: merged.derived, working: merged.working };
}

function withWorking(session: ImportSession, change: (w: ImportWorking) => ImportWorking): ImportSession {
  return { ...session, working: change(session.working) };
}

function preview(session: ImportSession, action: unknown): WritePlan {
  const planned = importKind.plan!(session, action as never);
  if (!planned.ok) throw new Error(planned.reason);
  return planned.plan;
}

function refused(session: ImportSession, action: unknown): string {
  const planned = importKind.plan!(session, action as never);
  if (planned.ok) throw new Error('the plan was not refused');
  return planned.reason;
}

async function apply(session: ImportSession, plan: WritePlan): Promise<{ session: ImportSession; results: Array<{ target: string; outcome: string; reason?: string }>; saved: number }> {
  let saved = 0;
  const applied = await importKind.apply!(session, plan, deps, async () => { saved++; });
  return { session: { ...session, derived: applied.derived, working: applied.working }, results: applied.results, saved };
}

const view = (session: ImportSession, tab?: string): ImportView =>
  importKind.view(tab ? { ...session, working: { ...session.working, tab: tab as never } } : session);
const tabOf = (v: ImportView, id: string) => v.tabs.find(t => t.id === id)!;
const newRefs = (s: ImportSession) => view(s, 'new').new!.rows.map(r => r.ref).sort();
const rowId = (s: ImportSession, tab: 'new' | 'ticketed', ref: string) => {
  const v = view(s, tab);
  const rows = tab === 'new' ? v.new!.rows : v.ticketed!.rows;
  return rows.find(r => r.ref === ref)!.id;
};
const label = (nameVersion: string) => sanitizeComponentLabel(nameVersion);

describe('accepting CVEs', () => {
  it('previews the one entry it adds, and after Apply the row has left New and the Accepted tab lists the entry', async () => {
    let session = await open(recipe('waltz', copyWaltz()));
    expect(newRefs(session)).toEqual(['example-http:3.3.3', 'example-io:4.5.0', 'example-lib:1.2.3']);

    const plan = preview(session, { type: 'accept-cve', ids: [rowId(session, 'new', 'example-io:4.5.0')], reason: 'not reachable' });
    expect(plan.risky).toBe(false);
    expect(plan.lines).toEqual([{ target: ACCEPTED_FILE_NAME, change: 'Add example-io · CVE-2099-0003 (not reachable)' }]);

    const done = await apply(session, plan);
    session = done.session;
    expect(done.results.map(r => r.outcome)).toEqual(['done']);
    expect(readList()).toEqual([{ component: 'example-io', cve: 'CVE-2099-0003', reason: 'not reachable' }]);
    expect(newRefs(session)).toEqual(['example-http:3.3.3', 'example-lib:1.2.3']);
    const accepted = view(session, 'accepted');
    expect(tabOf(accepted, 'accepted').count).toBe(1);
    expect(accepted.accepted!.rows).toEqual([{ component: 'example-io', cve: 'CVE-2099-0003', reason: 'not reachable' }]);
    // The board's own write is recorded, so a later check does not count it as someone else's change.
    expect(session.working.writes.acceptedFile).toBeDefined();
    expect(done.saved).toBe(1);
    const later = await check(session, 'background');
    expect(later.working.outOfDate).toEqual([]);
  });

  it('refuses when the accepted list could not be read in full, says why, and leaves the file as it is', async () => {
    fs.writeFileSync(listFile(), '{ "accepted": [ broken');
    const session = await open(recipe('waltz', copyWaltz()));
    const reason = refused(session, { type: 'accept-cve', ids: [rowId(session, 'new', 'example-io:4.5.0')] });
    expect(reason).toMatch(/not valid JSON/);
    expect(reason).toMatch(/fix it first/);
    expect(fs.readFileSync(listFile(), 'utf8')).toBe('{ "accepted": [ broken');
  });
});

describe('accepting components', () => {
  it('drops the component from New and Already ticketed, and its ticket moves onto Stale', async () => {
    jira.tickets = { 'PROJ-1': { labels: ['oss-dependency', label('example-lib:1.2.3')], updated: 't1' } };
    let session = await open(recipe('waltz', copyWaltz()));
    expect(newRefs(session)).toEqual(['example-http:3.3.3', 'example-io:4.5.0']);
    expect(view(session, 'ticketed').ticketed!.rows.map(r => r.ticket)).toEqual(['PROJ-1']);
    expect(tabOf(view(session), 'stale').count).toBe(0);

    const plan = preview(session, {
      type: 'accept-component', ids: [rowId(session, 'new', 'example-io:4.5.0'), rowId(session, 'ticketed', 'example-lib:1.2.3')],
    });
    expect(plan.risky).toBe(false);
    expect(plan.lines).toEqual([
      { target: ACCEPTED_FILE_NAME, change: 'Add example-lib:1.2.3 as a whole component' },
      { target: ACCEPTED_FILE_NAME, change: 'Add example-io:4.5.0 as a whole component' },
    ]);

    session = (await apply(session, plan)).session;
    expect(readList()).toEqual([{ component: 'example-lib', version: '1.2.3' }, { component: 'example-io', version: '4.5.0' }]);
    expect(newRefs(session)).toEqual(['example-http:3.3.3']);
    expect(tabOf(view(session), 'ticketed').count).toBe(0);
    expect(view(session, 'stale').stale!.rows.map(r => r.key)).toEqual(['PROJ-1']);
    expect(tabOf(view(session), 'accepted').count).toBe(2);
  });
});

describe('unaccepting', () => {
  it('marks a New tab that holds a merge out of date, and Refresh brings the CVE\'s component back and keeps the merge', async () => {
    writeList([{ component: 'example-io', cve: 'CVE-2099-0003' }]);
    let session = await open(recipe('waltz', copyWaltz()));
    expect(newRefs(session)).toEqual(['example-http:3.3.3', 'example-lib:1.2.3']);
    const merge = [label('example-http:3.3.3'), label('example-lib:1.2.3')];
    session = withWorking(session, w => ({ ...w, choices: { ...w.choices, merges: [merge] } }));

    const plan = preview(session, { type: 'unaccept', component: 'example-io', cve: 'CVE-2099-0003' });
    expect(plan.risky).toBe(false);
    expect(plan.lines).toEqual([{ target: ACCEPTED_FILE_NAME, change: 'Remove example-io · CVE-2099-0003' }]);

    session = (await apply(session, plan)).session;
    expect(readList()).toEqual([]);
    let v = view(session, 'new');
    expect(tabOf(v, 'new')).toMatchObject({ outOfDate: true, count: 2 });
    expect(tabOf(v, 'accepted')).toMatchObject({ outOfDate: false, count: 0 });

    session = await check(session, 'refresh');
    v = view(session, 'new');
    expect(tabOf(v, 'new')).toMatchObject({ outOfDate: false, count: 3 });
    expect(session.working.choices.merges).toEqual([merge]);
    expect(v.dropped).toEqual([]);
  });

  it('removes a component entry, and New takes the component back at once when it holds no unfinished choices', async () => {
    writeList([{ component: 'example-io', version: '4.5.0', reason: 'internal only' }]);
    let session = await open(recipe('waltz', copyWaltz()));
    expect(newRefs(session)).toEqual(['example-http:3.3.3', 'example-lib:1.2.3']);

    const plan = preview(session, { type: 'unaccept-component', component: 'example-io', version: '4.5.0' });
    expect(plan.risky).toBe(false);
    expect(plan.lines).toEqual([{ target: ACCEPTED_FILE_NAME, change: 'Remove example-io:4.5.0 (a whole component)' }]);

    session = (await apply(session, plan)).session;
    expect(readList()).toEqual([]);
    expect(tabOf(view(session), 'new')).toMatchObject({ outOfDate: false, count: 3 });
  });
});

describe('reloading the report', () => {
  it('previews the choices it may drop, and after Apply keeps those whose rows still exist and names the others', async () => {
    const file = writeVeracode([{ id: '101', file: 'A.java' }, { id: '102', file: 'B.java' }, { id: '103', file: 'C.java' }]);
    let session = await open(recipe('veracode', file));
    session = withWorking(session, w => ({ ...w, choices: { ...w.choices, excluded: ['101', '103'] } }));

    const plan = preview(session, { type: 'reload-report' });
    expect(plan.risky).toBe(false);
    expect(plan.lines).toEqual([
      { target: 'report.xml', change: 'Read the report and Jira again' },
      { target: 'Flaw 101', change: 'Left out of the create: kept if the row is still in the report, dropped otherwise' },
      { target: 'Flaw 103', change: 'Left out of the create: kept if the row is still in the report, dropped otherwise' },
    ]);

    // The report is edited: flaw 103 is gone, flaw 104 is new.
    writeVeracode([{ id: '101', file: 'A.java' }, { id: '102', file: 'B.java' }, { id: '104', file: 'D.java' }]);
    const done = await apply(session, plan);
    session = done.session;
    expect(done.results).toEqual([{ target: 'report.xml', outcome: 'done' }]);
    expect(session.working.choices.excluded).toEqual(['101']);
    const v = view(session, 'new');
    expect(v.new!.rows.map(r => r.ref)).toEqual(['Flaw 101', 'Flaw 102', 'Flaw 104']);
    expect(v.dropped).toHaveLength(1);
    expect(v.dropped[0]).toMatch(/Flaw 103/);
  });
});
