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
import type { JiraCreatedIssue, JiraIssue, JiraSearchResult } from '../jira/IJiraClient';
import type { Session, WritePlan } from '../sessions/sessionTypes';
import { buildGroupDescriptionWiki, buildGroupLabels, buildGroupSummary, buildRatingLabel, sanitizeComponentLabel, type WaltzComponent } from '../utils/waltzReport';
import type { RemediationDates } from '../utils/waltzDates';
import { MockJiraClient } from './mocks/MockJiraClient';

// The Already ticketed tab of the import board: it opens on the rows that need a decision, lets the
// developer set each row's action or every shown row's at once, and writes the chosen actions with
// the chat import's rules: a rewrite covers all rows of its ticket or none, a Veracode rewrite only
// moves the Due Date earlier, a Waltz rewrite takes the report's date, and a new ticket for a
// resolved one is a full ticket linked to it.

interface Ticket {
  labels: string[];
  summary?: string;
  status?: string;
  resolved?: boolean;
  updated: string;
  description?: string;
  duedate?: string | null;
}

class FakeJira extends MockJiraClient {
  tickets: Record<string, Ticket> = {};
  links: Array<{ from: string; to: string }> = [];
  private next = 500;
  private tick = 0;

  private touch(key: string) {
    this.tickets[key].updated = `w${++this.tick}`;
  }

  private issue(key: string): JiraIssue {
    const t = this.tickets[key];
    return {
      id: key, key,
      fields: {
        labels: t.labels, summary: t.summary ?? `Ticket ${key}`, status: { name: t.status ?? 'Open' },
        resolution: t.resolved ? { name: 'Done' } : null, created: '2026-01-01T09:00:00.000+0000', duedate: t.duedate ?? null,
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

  override async updateIssue(key: string, fields: Record<string, unknown>): Promise<void> {
    await super.updateIssue(key, fields);
    const t = this.tickets[key];
    if (Array.isArray(fields.labels)) t.labels = fields.labels as string[];
    if (typeof fields.summary === 'string') t.summary = fields.summary;
    if (typeof fields.description === 'string') t.description = fields.description;
    if ('duedate' in fields) t.duedate = fields.duedate as string | null;
    this.touch(key);
  }

  override async addComment(key: string, body: string): Promise<void> {
    await super.addComment(key, body);
    this.touch(key);
  }

  override async createIssue(projectKey: string, summary: string, issueType: string, additionalFields?: Record<string, unknown>): Promise<JiraCreatedIssue> {
    await super.createIssue(projectKey, summary, issueType, additionalFields);
    const key = `PROJ-${++this.next}`;
    this.tickets[key] = {
      labels: (additionalFields?.labels as string[] | undefined) ?? [], summary,
      description: String(additionalFields?.description ?? ''), duedate: (additionalFields?.duedate as string | undefined) ?? null, updated: 'new',
    };
    this.touch(key);
    return { id: key, key } as JiraCreatedIssue;
  }

  override async createIssueLink(inwardKey: string, outwardKey: string, typeName: string): Promise<void> {
    await super.createIssueLink(inwardKey, outwardKey, typeName);
    this.links.push({ from: outwardKey, to: inwardKey });
    this.touch(inwardKey);
    this.touch(outwardKey);
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
let slaDays: unknown;
let waltzItems: WaltzComponent[];

const MB = 20 * 1024 * 1024;

function makeDeps(): ImportDeps {
  const veracode = createVeracodeDescriptor({
    filter: () => ({ minSeverity: 3, includeStatuses: ['New', 'Open', 'Reopened'], maxReportBytes: MB }),
    slaDays: () => slaDays,
  }, { reviewColumns: [] });
  const waltzBase = createWaltzDescriptor({
    filter: () => ({ minVulnRating: 'High', includeRemediationActions: ['', 'Remediate'], maxReportBytes: MB }),
    minVulnRating: () => 'High',
    workspaceRoot: () => dir,
  }, { reviewColumns: [] });
  // The Waltz report's components, with remediation dates the sample workbook does not carry.
  const waltz = { ...waltzBase, parseAndFilter: async () => ({ items: waltzItems.map(c => [c]), rawItems: waltzItems }) };
  return importJiraDeps({
    getJira: async () => ({ configured: true, client: jira, config: { baseUrl: 'https://jira.example.com' } }) as never,
    workspaceFolder: () => dir,
    descriptors: { veracode, waltz },
    now: () => 1_000,
  });
}

let deps: ImportDeps;

beforeEach(async () => {
  dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ts-import-ticketed-'));
  jira = new FakeJira();
  slaDays = undefined;
  waltzItems = [];
  deps = makeDeps();
});

afterEach(async () => {
  await fs.promises.rm(dir, { recursive: true, force: true });
});

function writeVeracode(flaws: Flaw[]): string {
  const file = path.join(dir, 'report.xml');
  fs.writeFileSync(file, veracodeXml(flaws));
  return file;
}

function writeWaltz(components: WaltzComponent[]): string {
  waltzItems = components;
  const file = path.join(dir, 'oss.xlsx');
  fs.writeFileSync(file, 'stand-in: the descriptor returns the components above');
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

function act(session: ImportSession, action: unknown): ImportSession {
  const reduced = importKind.reduce(session, action as never);
  if (!reduced.ok) throw new Error(reduced.reason);
  return { ...session, working: reduced.working };
}

function plan(session: ImportSession): WritePlan {
  const planned = importKind.plan!(session, { type: 'ticketed-apply' } as never);
  if (!planned.ok) throw new Error(planned.reason);
  return planned.plan;
}

async function apply(session: ImportSession, p: WritePlan) {
  const reports: Array<{ done: number; total: number; working: ImportWorking }> = [];
  const applied = await importKind.apply!(session, p, deps, async r => { reports.push(r); });
  return { ...applied, reports, session: { ...session, derived: applied.derived, working: applied.working } as ImportSession };
}

const view = (session: ImportSession): ImportView => importKind.view(session);
const ext = (v: ImportView) => v.ext.ticketed as {
  filter: 'changed' | 'unchanged' | 'all'; shown: string[]; noDueDate: string[]; notice: string | null;
  counts: { changed: number; unchanged: number; all: number };
};
/** The Already-ticketed rows the tab shows under its filter, by ticket. */
const shownTickets = (v: ImportView) => v.ticketed!.rows.filter(r => ext(v).shown.includes(r.id)).map(r => r.ticket);
const rowOf = (v: ImportView, ticket: string) => v.ticketed!.rows.find(r => r.ticket === ticket)!;
const onTicketed = (s: ImportSession) => act(s, { type: 'tab', tab: 'ticketed' });

const veracodeTicket = (ids: string[], over: Partial<Ticket> = {}): Ticket => ({
  labels: ['veracode', ...ids.map(id => `veracode-issue-${id}`)], updated: 't1', ...over,
});

const comp = (nameVersion: string, dates: Partial<RemediationDates> = {}): WaltzComponent => ({
  nameVersion, maxVulnRating: 'High', remediationAction: 'Remediate', instancePaths: ['app.jar'],
  vulnerabilities: [
    { cveId: 'CVE-2099-0001', cveSummary: 'First flaw.', overallSeverity: 'High', cvssV3Score: 7, fixedVersion: null },
    { cveId: 'CVE-2099-0002', cveSummary: 'Second flaw.', overallSeverity: 'High', cvssV3Score: 7, fixedVersion: null },
  ],
  remediation: { policyDate: null, plannedDate: null, attestationDate: null, planStatus: null, reportDate: '2026-10-22', ...dates },
});

describe('the Already ticketed filters', () => {
  /**
   * 40 matched findings, each in its own file with its own ticket. The first 6 tickets record only
   * their first flaw while the report has a second one in the same file: those rows changed.
   */
  async function fortyRows(): Promise<ImportSession> {
    const flaws: Flaw[] = [];
    const tickets: Record<string, Ticket> = {};
    for (let n = 1; n <= 40; n++) {
      flaws.push({ id: `${n}01`, file: `F${n}.java` });
      if (n <= 6) flaws.push({ id: `${n}02`, file: `F${n}.java`, line: 20 });
      tickets[`PROJ-${n}`] = veracodeTicket([`${n}01`]);
    }
    jira.tickets = tickets;
    return open(recipe('veracode', writeVeracode(flaws)));
  }

  it('opens on the changed rows, and Unchanged and All show the others', async () => {
    let session = await fortyRows();
    let v = view(session);
    expect(v.tab).toBe('ticketed');
    expect(ext(v).filter).toBe('changed');
    expect(ext(v).counts).toEqual({ changed: 6, unchanged: 34, all: 40 });
    expect(shownTickets(v)).toEqual(['PROJ-1', 'PROJ-2', 'PROJ-3', 'PROJ-4', 'PROJ-5', 'PROJ-6']);

    session = act(session, { type: 'ticketed-filter', filter: 'unchanged' });
    v = view(session);
    expect(ext(v).filter).toBe('unchanged');
    expect(shownTickets(v)).toHaveLength(34);
    expect(shownTickets(v)[0]).toBe('PROJ-7');

    session = act(session, { type: 'ticketed-filter', filter: 'all' });
    expect(shownTickets(view(session))).toHaveLength(40);
  });

  it('sets all shown to leave on the Changed filter: only those 6 rows change, the 34 keep their own choice', async () => {
    let session = onTicketed(await fortyRows());
    const before = view(session);
    expect(rowOf(before, 'PROJ-1').action).toBe('rewrite');
    // One unchanged row the developer set to rewrite by hand.
    const all = view(act(session, { type: 'ticketed-filter', filter: 'all' }));
    session = act(session, { type: 'ticketed-action', id: rowOf(all, 'PROJ-9').id, action: 'rewrite' });

    expect(ext(view(session)).filter).toBe('changed');
    session = act(session, { type: 'ticketed-set-shown', action: 'leave' });
    session = act(session, { type: 'ticketed-filter', filter: 'all' });
    const v = view(session);
    for (let n = 1; n <= 6; n++) expect(rowOf(v, `PROJ-${n}`).action).toBe('leave');
    expect(rowOf(v, 'PROJ-9').action).toBe('rewrite');
    expect(v.ticketed!.rows.filter(r => r.action === 'leave')).toHaveLength(39);
  });

  it('skips the shown rows that do not offer the action and says how many', async () => {
    jira.tickets = {
      'PROJ-1': veracodeTicket(['101'], { resolved: true, status: 'Done' }),
      'PROJ-2': veracodeTicket(['201']),
      'PROJ-3': veracodeTicket(['301']),
    };
    const file = writeVeracode([
      { id: '101', file: 'A.java' }, { id: '102', file: 'A.java', line: 20 },
      { id: '201', file: 'B.java' }, { id: '202', file: 'B.java', line: 20 },
      { id: '301', file: 'C.java' }, { id: '302', file: 'C.java', line: 20 },
    ]);
    let session = onTicketed(await open(recipe('veracode', file)));
    expect(shownTickets(view(session))).toEqual(['PROJ-1', 'PROJ-2', 'PROJ-3']);

    session = act(session, { type: 'ticketed-set-shown', action: 'follow-up' });
    const v = view(session);
    expect(rowOf(v, 'PROJ-1').action).toBe('follow-up');
    expect(rowOf(v, 'PROJ-2').action).toBe('rewrite');
    expect(rowOf(v, 'PROJ-3').action).toBe('rewrite');
    expect(ext(v).notice).toMatch(/1 row/);
    expect(ext(v).notice).toMatch(/2 row\(s\)/);
    expect(ext(v).notice).toMatch(/new ticket/);
  });

  it('refuses an action the row does not offer', async () => {
    jira.tickets = { 'PROJ-1': veracodeTicket(['101']) };
    const session = onTicketed(await open(recipe('veracode', writeVeracode([{ id: '101', file: 'A.java' }, { id: '102', file: 'A.java', line: 20 }]))));
    const reduced = importKind.reduce(session, { type: 'ticketed-action', id: rowOf(view(session), 'PROJ-1').id, action: 'follow-up' } as never);
    expect(reduced.ok).toBe(false);
  });
});

describe('Due Dates on Already ticketed', () => {
  beforeEach(() => {
    // High findings are due 90 days after they were first found (2026-04-20): 2026-07-19.
    slaDays = { High: 90 };
  });

  it('flags an open ticket without a Due Date and defaults it to rewrite, which sets the date', async () => {
    jira.tickets = {
      'PROJ-1': veracodeTicket(['101'], { duedate: null }),
      'PROJ-2': veracodeTicket(['201'], { duedate: '2026-09-01' }),
    };
    let session = onTicketed(await open(recipe('veracode', writeVeracode([{ id: '101', file: 'A.java' }, { id: '201', file: 'B.java' }]))));
    const v = view(session);
    expect(ext(v).filter).toBe('changed');
    expect(shownTickets(v)).toEqual(['PROJ-1']);
    expect(ext(v).noDueDate).toEqual([rowOf(v, 'PROJ-1').id]);
    expect(rowOf(v, 'PROJ-1').action).toBe('rewrite');

    const p = plan(session);
    expect(p.lines.map(l => l.target)).toEqual(['PROJ-1']);
    const applied = await apply(session, p);
    expect(applied.results).toEqual([expect.objectContaining({ target: 'PROJ-1', outcome: 'done' })]);
    expect(applied.results[0].reason).toMatch(/2026-07-19/);
    expect(jira.tickets['PROJ-1'].duedate).toBe('2026-07-19');
    expect(jira.updateIssueCalls.map(c => c.issueKey)).toEqual(['PROJ-1']);
    session = applied.session;
    expect(session.working.writes.tickets['PROJ-1']).toEqual({ updated: jira.tickets['PROJ-1'].updated });
  });

  it('a Veracode rewrite only moves the Due Date earlier', async () => {
    jira.tickets = {
      // A later date: the joining finding is due sooner, so the date moves to 2026-07-19.
      'PROJ-1': veracodeTicket(['101'], { duedate: '2026-12-31' }),
      // An earlier date: it stays.
      'PROJ-2': veracodeTicket(['201'], { duedate: '2026-05-01' }),
    };
    const file = writeVeracode([
      { id: '101', file: 'A.java' }, { id: '102', file: 'A.java', line: 20 },
      { id: '201', file: 'B.java' }, { id: '202', file: 'B.java', line: 20 },
    ]);
    const session = onTicketed(await open(recipe('veracode', file)));
    const applied = await apply(session, plan(session));
    expect(applied.results.map(r => r.outcome)).toEqual(['done', 'done']);
    expect(jira.tickets['PROJ-1'].duedate).toBe('2026-07-19');
    expect(jira.tickets['PROJ-2'].duedate).toBe('2026-05-01');
    expect(jira.updateIssueCalls.find(c => c.issueKey === 'PROJ-2')!.fields).not.toHaveProperty('duedate');
    expect(jira.tickets['PROJ-1'].labels).toEqual(expect.arrayContaining(['veracode-issue-101', 'veracode-issue-102']));
    // Each finished ticket was saved before the next write.
    expect(applied.reports.map(r => [r.done, r.total])).toEqual([[1, 2], [2, 2]]);
    expect(Object.keys(applied.reports[0].working.writes.tickets)).toHaveLength(1);
  });

  it('a Waltz rewrite takes the date of the regenerated group, even a later one', async () => {
    const undated = comp('example-lib:1.2.3');
    jira.tickets = {
      'PROJ-1': {
        labels: buildGroupLabels([undated]), description: buildGroupDescriptionWiki([undated]), updated: 't1', duedate: '2026-10-01',
      },
    };
    const session = onTicketed(await open(recipe('waltz', writeWaltz([comp('example-lib:1.2.3', { plannedDate: '2026-12-15' })]))));
    const v = view(session);
    expect(shownTickets(v)).toEqual(['PROJ-1']);
    expect(rowOf(v, 'PROJ-1').action).toBe('rewrite');

    const applied = await apply(session, plan(session));
    expect(applied.results).toEqual([expect.objectContaining({ target: 'PROJ-1', outcome: 'done' })]);
    expect(applied.results[0].reason).toMatch(/2026-12-15/);
    expect(jira.tickets['PROJ-1'].duedate).toBe('2026-12-15');
  });
});

describe('applying the Already ticketed actions', () => {
  /** Two findings in different files whose ticket records one flaw of each; the report has a new flaw in each file. */
  async function twoRowsOneTicket(): Promise<ImportSession> {
    jira.tickets = { 'PROJ-1': veracodeTicket(['101', '201']) };
    const file = writeVeracode([
      { id: '101', file: 'A.java' }, { id: '102', file: 'A.java', line: 20 },
      { id: '201', file: 'B.java' }, { id: '202', file: 'B.java', line: 20 },
    ]);
    return onTicketed(await open(recipe('veracode', file)));
  }

  it('refuses a rewrite that covers only some rows of its ticket and writes nothing', async () => {
    let session = await twoRowsOneTicket();
    const rows = view(session).ticketed!.rows;
    expect(rows.map(r => [r.ticket, r.action])).toEqual([['PROJ-1', 'rewrite'], ['PROJ-1', 'rewrite']]);

    session = act(session, { type: 'ticketed-action', id: rows[1].id, action: 'leave' });
    const planned = importKind.plan!(session, { type: 'ticketed-apply' } as never);
    expect(planned.ok).toBe(false);
    if (!planned.ok) expect(planned.reason).toMatch(/PROJ-1/);
    expect(jira.updateIssueCalls).toHaveLength(0);
  });

  it('rewrites the two rows of one ticket together, in one write', async () => {
    const session = await twoRowsOneTicket();
    const p = plan(session);
    expect(p.lines).toHaveLength(1);
    expect(p.lines[0].target).toBe('PROJ-1');
    expect(p.risky).toBe(false);

    const applied = await apply(session, p);
    expect(applied.results).toEqual([expect.objectContaining({ target: 'PROJ-1', outcome: 'done' })]);
    expect(jira.updateIssueCalls).toHaveLength(1);
    expect(jira.tickets['PROJ-1'].labels).toEqual(expect.arrayContaining(
      ['veracode-issue-101', 'veracode-issue-102', 'veracode-issue-201', 'veracode-issue-202']));
    const after = view(applied.session);
    expect(after.ticketed!.rows.every(r => r.written && !r.needsDecision)).toBe(true);
    expect(importKind.plan!(applied.session, { type: 'ticketed-apply' } as never).ok).toBe(false);
  });

  it('a Waltz rewrite of a merged ticket whose member left the report drops its label and swaps the rating label', async () => {
    const kept = comp('example-lib:1.2.3');
    const gone = { ...comp('other-lib:2.0.0'), maxVulnRating: 'Critical' };
    jira.tickets = {
      'PROJ-1': {
        labels: buildGroupLabels([kept, gone]), summary: buildGroupSummary([kept, gone]),
        description: buildGroupDescriptionWiki([kept, gone]), updated: 't1',
      },
    };
    const session = onTicketed(await open(recipe('waltz', writeWaltz([kept]))));
    const v = view(session);
    expect(rowOf(v, 'PROJ-1').action).toBe('rewrite');

    const applied = await apply(session, plan(session));
    expect(applied.results).toEqual([expect.objectContaining({ target: 'PROJ-1', outcome: 'done' })]);
    const labels = jira.tickets['PROJ-1'].labels;
    expect(labels).toEqual(expect.arrayContaining(buildGroupLabels([kept])));
    expect(labels).not.toContain(sanitizeComponentLabel('other-lib:2.0.0'));
    expect(labels).not.toContain(buildRatingLabel('Critical'));
    expect(jira.tickets['PROJ-1'].summary).toBe(buildGroupSummary([kept]));
  });

  it('a new ticket for a resolved Waltz ticket is a full ticket linked to it', async () => {
    jira.tickets = {
      'PROJ-1': { labels: buildGroupLabels([comp('example-lib:1.2.3')]), resolved: true, status: 'Done', updated: 't1' },
    };
    let session = onTicketed(await open(recipe('waltz', writeWaltz([comp('example-lib:1.2.3')]))));
    let v = view(act(session, { type: 'ticketed-filter', filter: 'all' }));
    expect(rowOf(v, 'PROJ-1').allowedActions).toContain('follow-up');
    session = act(session, { type: 'ticketed-action', id: rowOf(v, 'PROJ-1').id, action: 'follow-up' });

    const p = plan(session);
    expect(p.lines).toEqual([expect.objectContaining({ target: 'PROJ-1' })]);
    expect(p.lines[0].change).toMatch(/new ticket/i);
    const applied = await apply(session, p);
    expect(applied.results).toEqual([expect.objectContaining({ target: 'PROJ-1', outcome: 'done' })]);

    expect(jira.createIssueCalls).toHaveLength(1);
    const created = Object.keys(jira.tickets).find(k => k !== 'PROJ-1')!;
    expect(applied.results[0].reason).toContain(created);
    expect(jira.tickets[created].labels).toContain(sanitizeComponentLabel('example-lib:1.2.3'));
    expect(jira.tickets[created].description).toContain('CVE-2099-0001');
    expect(jira.tickets[created].description).toContain('CVE-2099-0002');
    expect(jira.links).toEqual([{ from: created, to: 'PROJ-1' }]);
    expect(applied.session.working.writes.tickets).toEqual({
      'PROJ-1': { updated: jira.tickets['PROJ-1'].updated },
      [created]: { updated: jira.tickets[created].updated },
    });
    // The follow-up is the row's ticket in the next reading, not a New row's create.
    expect(applied.session.working.writes.created).toEqual([]);
    v = view(applied.session);
    expect(rowOf(v, 'PROJ-1').written).toBe(true);
  });

  it('a later check does not count the row moving to the board\'s own new ticket as a change', async () => {
    jira.tickets = {
      'PROJ-1': { labels: buildGroupLabels([comp('example-lib:1.2.3')]), resolved: true, status: 'Done', updated: 't1' },
      'PROJ-2': { labels: buildGroupLabels([comp('other-lib:2.0.0')]), status: 'Open', updated: 't2' },
    };
    const r = recipe('waltz', writeWaltz([comp('example-lib:1.2.3'), comp('other-lib:2.0.0')]));
    let session = onTicketed(await open(r));
    let v = view(act(session, { type: 'ticketed-filter', filter: 'all' }));
    session = act(session, { type: 'ticketed-action', id: rowOf(v, 'PROJ-1').id, action: 'follow-up' });
    session = (await apply(session, plan(session))).session;
    // A choice not applied yet on another row of the same tab.
    v = view(act(session, { type: 'ticketed-filter', filter: 'all' }));
    const other = rowOf(v, 'PROJ-2');
    const choice = other.allowedActions.find(a => a !== other.action)!;
    session = act(session, { type: 'ticketed-action', id: other.id, action: choice });

    const fresh = await importKind.read(r, deps);
    const checked = importKind.reconcile(session, fresh, 'background');

    expect(checked.working.outOfDate).not.toContain('ticketed');
  });

  it('writes at most 50 tickets per Apply and says how many remain', async () => {
    const flaws: Flaw[] = [];
    const tickets: Record<string, Ticket> = {};
    for (let n = 1; n <= 52; n++) {
      flaws.push({ id: `${n}01`, file: `F${n}.java` }, { id: `${n}02`, file: `F${n}.java`, line: 20 });
      tickets[`PROJ-${n}`] = veracodeTicket([`${n}01`]);
    }
    jira.tickets = tickets;
    const session = onTicketed(await open(recipe('veracode', writeVeracode(flaws))));
    const p = plan(session);
    expect(p.lines).toHaveLength(50);
    expect(p.risky).toBe(true);
    expect(p.title).toMatch(/2 .*remain/);
  });
});
