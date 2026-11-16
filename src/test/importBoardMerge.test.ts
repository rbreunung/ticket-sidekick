import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { importKind, type ImportView, type ImportWorking } from '../boards/import/kind';
import { importJiraDeps } from '../boards/import/jiraDeps';
import type { MergeTabView } from '../boards/import/mergeTab';
import type { ImportData, ImportDeps } from '../boards/import/read';
import { importSessionId, type ImportRecipe } from '../boards/import/recipe';
import { createVeracodeDescriptor } from '../imports/veracode';
import { createWaltzDescriptor } from '../imports/waltz';
import type { JiraIssue, JiraSearchResult } from '../jira/IJiraClient';
import type { Session, WritePlan } from '../sessions/sessionTypes';
import { buildGroupLabels, type WaltzComponent } from '../utils/waltzReport';
import { MockJiraClient } from './mocks/MockJiraClient';

// The ticket merge on the import board: the developer selects Already-ticketed rows (or types ticket
// keys), names the ticket to keep, previews the merge and applies it. The run is kept with the
// session, so after a failed step or a restart it shows its finished, failed and pending steps and
// offers Retry, Ignore and Stop. The closing step asks a target status and resolution for every
// issue type of the sources first, then one Apply closes them all.

interface Ticket {
  labels: string[];
  summary?: string;
  status?: string;
  /** The resolution name; absent or null while the ticket is open. */
  resolution?: string | null;
  issueType?: string;
  updated: string;
  description?: string;
  created?: string;
}

/** Where each transition of the test workflows leads. */
const TRANSITIONS: Record<string, string> = { '31': 'Closed', '41': 'Done' };

class FakeJira extends MockJiraClient {
  tickets: Record<string, Ticket> = {};
  links: Array<{ from: string; to: string; type: string }> = [];
  comments: Record<string, string[]> = {};
  resolutionNames = ['Fixed', "Won't Fix", 'Duplicate', 'Done'];
  failLinkFor = new Set<string>();
  failTransitionFor = new Set<string>();
  transitions: Array<{ key: string; to: string; resolution: string | null }> = [];
  private tick = 0;

  touch(key: string) {
    this.tickets[key].updated = `w${++this.tick}`;
  }

  private issue(key: string): JiraIssue {
    const t = this.tickets[key];
    const issuelinks = this.links.filter(l => l.from === key || l.to === key).map((l, i) => ({
      id: String(i), type: { name: l.type, inward: 'is duplicated by', outward: 'duplicates' },
      ...(l.from === key ? { outwardIssue: { key: l.to } } : { inwardIssue: { key: l.from } }),
    }));
    const comments = (this.comments[key] ?? []).map((body, i) => ({ id: String(i), author: {}, body, created: '2026-11-01' }));
    return {
      id: key, key,
      fields: {
        labels: t.labels, summary: t.summary ?? `Ticket ${key}`, status: { name: t.status ?? 'Open' },
        resolution: t.resolution ? { name: t.resolution } : null, created: t.created ?? '2026-01-01T09:00:00.000+0000', duedate: null,
        updated: t.updated, issuetype: { name: t.issueType ?? 'Bug' }, fixVersions: [], description: t.description ?? '',
        issuelinks, comment: { comments, total: comments.length },
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
      keys = all.filter(k => !this.tickets[k].resolution && this.tickets[k].labels.includes(marker));
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

  override async getResolutions(): Promise<Array<{ name: string }>> {
    return this.resolutionNames.map(name => ({ name }));
  }

  override async updateIssue(key: string, fields: Record<string, unknown>): Promise<void> {
    await super.updateIssue(key, fields);
    const t = this.tickets[key];
    if (Array.isArray(fields.labels)) t.labels = fields.labels as string[];
    if (typeof fields.summary === 'string') t.summary = fields.summary;
    if (typeof fields.description === 'string') t.description = fields.description;
    this.touch(key);
  }

  override async addComment(key: string, body: string): Promise<void> {
    await super.addComment(key, body);
    (this.comments[key] ??= []).push(body);
    this.touch(key);
  }

  override async createIssueLink(inwardKey: string, outwardKey: string, typeName: string): Promise<void> {
    if (this.failLinkFor.has(outwardKey)) throw Object.assign(new Error('Jira answered 500 on the link'), { status: 500 });
    await super.createIssueLink(inwardKey, outwardKey, typeName);
    this.links.push({ from: outwardKey, to: inwardKey, type: typeName });
    this.touch(inwardKey);
    this.touch(outwardKey);
  }

  override async executeTransition(key: string, transitionId: string, fields?: Record<string, unknown>): Promise<void> {
    if (this.failTransitionFor.has(key)) throw Object.assign(new Error('Jira answered 500 on the transition'), { status: 500 });
    await super.executeTransition(key, transitionId, fields);
    const t = this.tickets[key];
    t.status = TRANSITIONS[transitionId];
    const resolution = (fields?.resolution as { name: string } | undefined)?.name ?? null;
    t.resolution = resolution ?? 'Done';
    this.transitions.push({ key, to: t.status, resolution });
    this.touch(key);
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
let waltzItems: WaltzComponent[];

const MB = 20 * 1024 * 1024;

beforeEach(async () => {
  dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ts-import-merge-'));
  jira = new FakeJira();
  waltzItems = [];
  const veracode = createVeracodeDescriptor({
    filter: () => ({ minSeverity: 3, includeStatuses: ['New', 'Open', 'Reopened'], maxReportBytes: MB }),
    slaDays: () => undefined,
  }, { reviewColumns: [] });
  const waltzBase = createWaltzDescriptor({
    filter: () => ({ minVulnRating: 'High', includeRemediationActions: ['', 'Remediate'], maxReportBytes: MB }),
    minVulnRating: () => 'High',
    workspaceRoot: () => dir,
  }, { reviewColumns: [] });
  // The Waltz report's components come straight from the test.
  const waltz = { ...waltzBase, parseAndFilter: async () => ({ items: waltzItems.map(c => [c]), rawItems: waltzItems }) };
  deps = importJiraDeps({
    getJira: async () => ({ configured: true, client: jira, config: { baseUrl: 'https://jira.example.com' } }) as never,
    workspaceFolder: () => dir,
    descriptors: { veracode, waltz },
    now: () => 1_000,
  });
  // Bug: Open → Closed. Task: Open → Done.
  fs.writeFileSync(path.join(dir, '.jira-workflow-cache.json'), JSON.stringify({
    PROJ: {
      Bug: { discovered: '2026-01-01', graph: { Open: [{ id: '31', name: 'Close', to: 'Closed' }] } },
      Task: { discovered: '2026-01-01', graph: { Open: [{ id: '41', name: 'Finish', to: 'Done' }] } },
    },
  }));
});

afterEach(async () => {
  await fs.promises.rm(dir, { recursive: true, force: true });
});

const comp = (nameVersion: string): WaltzComponent => ({
  nameVersion, maxVulnRating: 'High', remediationAction: 'Remediate', instancePaths: ['app.jar'],
  vulnerabilities: [{ cveId: `CVE-2099-${nameVersion.length}`, cveSummary: 'A flaw.', overallSeverity: 'High', cvssV3Score: 7, fixedVersion: null }],
  remediation: { policyDate: null, plannedDate: null, attestationDate: null, planStatus: null, reportDate: '2026-10-22' },
});

const libfoo = comp('libfoo:1.0');
const libbar = comp('libbar:2.0');
const libbaz = comp('libbaz:3.0');

function writeWaltz(components: WaltzComponent[]): string {
  waltzItems = components;
  const file = path.join(dir, 'oss.xlsx');
  fs.writeFileSync(file, 'stand-in: the descriptor returns the components above');
  return file;
}

function writeVeracode(flaws: Flaw[]): string {
  const file = path.join(dir, 'report.xml');
  fs.writeFileSync(file, veracodeXml(flaws));
  return file;
}

const waltzTicket = (c: WaltzComponent, over: Partial<Ticket> = {}): Ticket => ({ labels: buildGroupLabels([c]), status: 'Open', updated: 't1', ...over });

/** The kept ticket PROJ-12 and two related tickets PROJ-15 and PROJ-18, one per component. */
function threeWaltzTickets(over: Partial<Record<'PROJ-12' | 'PROJ-15' | 'PROJ-18', Partial<Ticket>>> = {}) {
  jira.tickets = {
    'PROJ-12': waltzTicket(libfoo, { summary: 'libfoo ticket', ...over['PROJ-12'] }),
    'PROJ-15': waltzTicket(libbar, { summary: 'libbar ticket', ...over['PROJ-15'] }),
    'PROJ-18': waltzTicket(libbaz, { summary: 'libbaz ticket', ...over['PROJ-18'] }),
  };
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

const openWaltz = () => open(recipe('waltz', writeWaltz([libfoo, libbar, libbaz])));

function act(session: ImportSession, action: unknown): ImportSession {
  const reduced = importKind.reduce(session, action as never);
  if (!reduced.ok) throw new Error(reduced.reason);
  return { ...session, working: reduced.working };
}

function refusedAction(session: ImportSession, action: unknown): string {
  const reduced = importKind.reduce(session, action as never);
  if (reduced.ok) throw new Error('expected a refusal');
  return reduced.reason;
}

/** What the board answers to a preview: the kind reads what the action needs, then plans. */
async function planned(session: ImportSession, action: unknown) {
  const prepared = await importKind.prepare!(session, action as never, deps);
  return importKind.plan!(session, action as never, prepared);
}

async function preview(session: ImportSession, action: unknown): Promise<WritePlan> {
  const p = await planned(session, action);
  if (!p.ok) throw new Error(p.reason);
  return p.plan;
}

async function refusedPlan(session: ImportSession, action: unknown): Promise<string> {
  const p = await planned(session, action);
  if (p.ok) throw new Error('expected a refusal');
  return p.reason;
}

async function apply(session: ImportSession, p: WritePlan) {
  const reports: Array<{ done: number; total: number; working: ImportWorking }> = [];
  const applied = await importKind.apply!(session, p, deps, async r => { reports.push(JSON.parse(JSON.stringify(r))); });
  return { ...applied, reports, session: { ...session, derived: applied.derived, working: applied.working } as ImportSession };
}

/** A session as a restart brings it back: through the store's JSON. */
const restart = (session: ImportSession): ImportSession => JSON.parse(JSON.stringify(session));

const view = (session: ImportSession): ImportView => importKind.view(session);
const mergeView = (session: ImportSession) => view(session).ext.merge as MergeTabView | undefined;
const stepsOf = (session: ImportSession) => mergeView(session)!.steps.map(s => `${s.kind} ${s.key}: ${s.status}`);

/** The id of the Already-ticketed row whose target is `ticket`. */
function rowFor(session: ImportSession, ticket: string): string {
  const row = session.derived.data.review.allRows.find(r => r.existingTicketKey !== null && (r.target?.key ?? r.existingTicketKey) === ticket);
  if (!row) throw new Error(`no row for ${ticket}`);
  return row.id;
}

/** Selects the rows of the three tickets and keeps PROJ-12. */
function mergeThree(session: ImportSession) {
  return { type: 'merge-start', ids: [rowFor(session, 'PROJ-12'), rowFor(session, 'PROJ-15'), rowFor(session, 'PROJ-18')], keep: rowFor(session, 'PROJ-12') };
}

describe('a Waltz ticket merge', () => {
  it('rewrites the kept ticket, links, marks and closes each source, after a risky opening Apply and one closing Apply', async () => {
    threeWaltzTickets();
    let session = await openWaltz();

    const opening = await preview(session, mergeThree(session));
    expect(opening.risky).toBe(true);
    expect(opening.title).toBe('Merge 2 tickets into PROJ-12');
    const targets = opening.lines.map(l => l.target);
    expect(targets).toEqual(expect.arrayContaining(['PROJ-12', 'PROJ-15', 'PROJ-18']));
    expect(opening.lines.find(l => l.target === 'PROJ-12' && /^Kept/.test(l.change))?.change).toBe('Kept: libfoo ticket (Open)');

    const started = await apply(session, opening);
    session = started.session;
    expect(stepsOf(session)).toEqual([
      'survivor-rewrite PROJ-12: done', 'survivor-comment PROJ-12: done',
      'link PROJ-15: done', 'source-rewrite PROJ-15: done', 'link PROJ-18: done', 'source-rewrite PROJ-18: done',
      'close PROJ-15: pending', 'close PROJ-18: pending',
    ]);
    // Each finished step was saved on its own, with the run as it stood then.
    expect(started.reports.map(r => r.done)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(started.reports.every(r => r.total === 8)).toBe(true);

    expect(jira.tickets['PROJ-12'].labels).toEqual(expect.arrayContaining([...buildGroupLabels([libbar]), ...buildGroupLabels([libbaz])]));
    expect(jira.comments['PROJ-12']).toHaveLength(1);
    expect(jira.comments['PROJ-12'][0]).toMatch(/^h4\. Merged tickets\nThis ticket took over the items of PROJ-15, PROJ-18/);
    expect(jira.links).toEqual([{ from: 'PROJ-15', to: 'PROJ-12', type: 'Duplicate' }, { from: 'PROJ-18', to: 'PROJ-12', type: 'Duplicate' }]);
    expect(jira.tickets['PROJ-15'].summary).toBe('[Merged into PROJ-12] libbar ticket');
    expect(jira.tickets['PROJ-18'].summary).toBe('[Merged into PROJ-12] libbaz ticket');
    expect(session.working.writes.tickets).toEqual({
      'PROJ-12': { updated: jira.tickets['PROJ-12'].updated },
      'PROJ-15': { updated: jira.tickets['PROJ-15'].updated },
      'PROJ-18': { updated: jira.tickets['PROJ-18'].updated },
    });

    let m = mergeView(session)!;
    expect(m.state).toBe('awaiting-close');
    expect(m.question).toEqual({
      groups: [{
        issueType: 'Bug', tickets: ['PROJ-15', 'PROJ-18'], targetOptions: [{ id: 'status:Closed', label: 'Closed' }], target: null,
        needsResolution: false, resolutionOptions: [], resolution: null,
      }],
      resolution: 'Duplicate',
      unanswered: ['Bug'],
    });
    expect(await refusedPlan(session, { type: 'merge-close' })).toBe('Pick the target status for Bug first.');

    session = act(session, { type: 'merge-close-target', issueType: 'Bug', option: 'status:Closed' });
    const closing = await preview(session, { type: 'merge-close' });
    expect(closing.risky).toBe(true);
    expect(closing.lines).toEqual([
      { target: 'PROJ-15', change: 'Close as Closed with resolution Duplicate' },
      { target: 'PROJ-18', change: 'Close as Closed with resolution Duplicate' },
    ]);
    session = (await apply(session, closing)).session;

    expect(jira.transitions).toEqual([
      { key: 'PROJ-15', to: 'Closed', resolution: 'Duplicate' },
      { key: 'PROJ-18', to: 'Closed', resolution: 'Duplicate' },
    ]);
    m = mergeView(session)!;
    expect(m.state).toBe('finished');
    expect(m.report).toEqual({ missing: [], closedWithout: [], workflowHint: false });

    session = act(session, { type: 'merge-acknowledge' });
    expect(mergeView(session)).toBeUndefined();
  });

  it('accepts a kept ticket typed as a key outside the report, and refuses one Jira does not have with the chat\'s message', async () => {
    threeWaltzTickets();
    jira.tickets['PROJ-77'] = { labels: ['other'], summary: 'Hand-made ticket', status: 'Open', updated: 't1' };
    const session = await openWaltz();

    const p = await preview(session, { type: 'merge-start', ids: [rowFor(session, 'PROJ-15')], keep: 'proj-77' });
    expect(p.title).toBe('Merge 1 ticket into PROJ-77');
    expect(p.lines).toContainEqual({ target: 'PROJ-77', change: 'Kept: Hand-made ticket (Open)' });
    expect(p.lines).toContainEqual({ target: 'PROJ-77', change: 'Warning: PROJ-77 was not created by an import, so rewriting from the report replaces text the report does not know.' });

    expect(await refusedPlan(session, { type: 'merge-start', ids: [rowFor(session, 'PROJ-15')], keep: 'PROJ-404' }))
      .toBe('Could not read all the tickets, so nothing was written: Jira answered 404');
    expect(await refusedPlan(session, { type: 'merge-start', ids: [rowFor(session, 'PROJ-15')], keep: rowFor(session, 'PROJ-18') }))
      .toBe('Pick the ticket to keep from the selected rows, or type its ticket key.');
  });

  it('after a failed link offers Retry, Ignore and Stop; Retry previews that one step, is not risky and the run carries on', async () => {
    threeWaltzTickets();
    jira.failLinkFor.add('PROJ-18');
    let session = await openWaltz();
    session = (await apply(session, await preview(session, mergeThree(session)))).session;

    let m = mergeView(session)!;
    expect(m.state).toBe('failed');
    expect(m.actions).toEqual(['retry', 'ignore', 'stop']);
    expect(m.failed).toMatchObject({ kind: 'link', key: 'PROJ-18', status: 'failed', error: 'Jira answered 500 on the link' });
    expect(stepsOf(session)).toEqual([
      'survivor-rewrite PROJ-12: done', 'survivor-comment PROJ-12: done',
      'link PROJ-15: done', 'source-rewrite PROJ-15: done', 'link PROJ-18: failed', 'source-rewrite PROJ-18: pending',
      'close PROJ-15: pending', 'close PROJ-18: pending',
    ]);

    jira.failLinkFor.clear();
    const retry = await preview(session, { type: 'merge-retry' });
    expect(retry.risky).toBe(false);
    expect(retry.lines[0]).toEqual({ target: 'PROJ-18', change: 'Run again: link the tickets' });
    session = (await apply(session, retry)).session;

    expect(jira.links.map(l => l.from)).toEqual(['PROJ-15', 'PROJ-18']);
    m = mergeView(session)!;
    expect(m.state).toBe('awaiting-close');
    expect(stepsOf(session)).toContain('source-rewrite PROJ-18: done');
  });

  it('Ignore skips the failed step, and Stop ends the run keeping what is done and reports what is missing', async () => {
    threeWaltzTickets();
    jira.failLinkFor.add('PROJ-18');
    let session = await openWaltz();
    session = (await apply(session, await preview(session, mergeThree(session)))).session;

    const ignore = await preview(session, { type: 'merge-ignore' });
    expect(ignore.risky).toBe(false);
    expect(ignore.lines[0]).toEqual({ target: 'PROJ-18', change: 'Skip: link the tickets, and carry on with the rest' });
    session = (await apply(session, ignore)).session;
    expect(stepsOf(session)).toContain('link PROJ-18: skipped');
    expect(mergeView(session)!.state).toBe('awaiting-close');

    const stop = await preview(session, { type: 'merge-stop' });
    expect(stop.risky).toBe(false);
    session = (await apply(session, stop)).session;
    const m = mergeView(session)!;
    expect(m.state).toBe('finished');
    expect(m.actions).toEqual(['acknowledge']);
    expect(m.report!.missing.map(s => `${s.label} ${s.key}`)).toEqual(['link the tickets PROJ-18', 'close PROJ-15', 'close PROJ-18']);
    expect(jira.transitions).toEqual([]);
  });

  it('asks target and resolution for a Bug and a Task source, then one risky Apply closes both', async () => {
    threeWaltzTickets({ 'PROJ-18': { issueType: 'Task' } });
    jira.resolutionNames = ['Fixed', "Won't Fix"];
    let session = await openWaltz();
    session = (await apply(session, await preview(session, mergeThree(session)))).session;

    let m = mergeView(session)!;
    expect(m.state).toBe('awaiting-close');
    expect(m.question!.groups.map(g => [g.issueType, g.tickets, g.targetOptions.map(o => o.id), g.needsResolution])).toEqual([
      ['Bug', ['PROJ-15'], ['status:Closed'], true],
      ['Task', ['PROJ-18'], ['status:Done'], true],
    ]);
    expect(m.question!.groups[0].resolutionOptions).toEqual([
      { id: 'resolution:Fixed', label: 'Fixed' }, { id: "resolution:Won't Fix", label: "Won't Fix" }, { id: 'none', label: 'No resolution' },
    ]);
    expect(m.question!.unanswered).toEqual(['Bug', 'Task']);
    expect(refusedAction(session, { type: 'merge-close-target', issueType: 'Bug', option: 'Closed' })).toBe('Pick one of the offered statuses.');

    session = act(session, { type: 'merge-close-target', issueType: 'Bug', option: 'status:Closed' });
    session = act(session, { type: 'merge-close-resolution', issueType: 'Bug', resolution: "resolution:Won't Fix" });
    session = act(session, { type: 'merge-close-target', issueType: 'Task', option: 'status:Done' });
    expect(await refusedPlan(session, { type: 'merge-close' })).toBe('Pick the resolution for Task first.');
    session = act(session, { type: 'merge-close-resolution', issueType: 'Task', resolution: 'none' });
    expect(mergeView(session)!.question!.unanswered).toEqual([]);

    const closing = await preview(session, { type: 'merge-close' });
    expect(closing.risky).toBe(true);
    expect(closing.lines).toEqual([
      { target: 'PROJ-15', change: "Close as Closed with resolution Won't Fix" },
      { target: 'PROJ-18', change: 'Close as Done without a resolution' },
    ]);
    session = (await apply(session, closing)).session;

    expect(jira.transitions).toEqual([
      { key: 'PROJ-15', to: 'Closed', resolution: "Won't Fix" },
      { key: 'PROJ-18', to: 'Done', resolution: null },
    ]);
    m = mergeView(session)!;
    expect(m.state).toBe('finished');
    expect(m.report!.missing).toEqual([]);
  });

  it('while the run waits, Apply on New is refused with a note to finish or stop the merge, and selecting New rows still works', async () => {
    threeWaltzTickets();
    const libnew = comp('libnew:4.0');
    let session = await open(recipe('waltz', writeWaltz([libfoo, libbar, libbaz, libnew])));
    session = (await apply(session, await preview(session, mergeThree(session)))).session;
    expect(mergeView(session)!.state).toBe('awaiting-close');

    expect(await refusedPlan(session, { type: 'new-create' })).toBe('A ticket merge is not finished. Finish or stop the merge first.');
    const newRow = session.derived.data.review.allRows.find(r => r.existingTicketKey === null)!;
    session = act(session, { type: 'new-include', ids: [newRow.id], included: false });
    expect(view(act(session, { type: 'tab', tab: 'new' })).new!.rows.find(r => r.id === newRow.id)!.included).toBe(false);
    // A second merge waits for this one.
    expect(await refusedPlan(session, mergeThree(session))).toBe('A ticket merge is not finished. Finish or stop it first.');
  });

  it('a Refresh while the run waits keeps the Already-ticketed reading the merge works from and marks that tab', async () => {
    threeWaltzTickets();
    const r = recipe('waltz', writeWaltz([libfoo, libbar, libbaz]));
    let session = await open(r);
    session = (await apply(session, await preview(session, mergeThree(session)))).session;
    expect(mergeView(session)!.state).toBe('awaiting-close');
    const before = session.derived.data.review.allRows.filter(row => row.existingTicketKey !== null).map(row => row.id);

    const refreshed = importKind.reconcile(session, await importKind.read(r, deps), 'refresh');

    expect(refreshed.derived.data.review.allRows.filter(row => row.existingTicketKey !== null).map(row => row.id)).toEqual(before);
    expect(refreshed.working.outOfDate).toEqual(['ticketed']);
  });

  it('comes back after a restart with its finished, failed and pending steps and the same choices', async () => {
    threeWaltzTickets();
    jira.failLinkFor.add('PROJ-15');
    let session = await openWaltz();
    session = (await apply(session, await preview(session, mergeThree(session)))).session;
    const before = mergeView(session);

    const restored = restart(session);
    expect(mergeView(restored)).toEqual(before);
    expect(stepsOf(restored)).toEqual([
      'survivor-rewrite PROJ-12: done', 'survivor-comment PROJ-12: done',
      'link PROJ-15: failed', 'source-rewrite PROJ-15: pending', 'link PROJ-18: pending', 'source-rewrite PROJ-18: pending',
      'close PROJ-15: pending', 'close PROJ-18: pending',
    ]);
    expect(mergeView(restored)!.actions).toEqual(['retry', 'ignore', 'stop']);
  });

  it('cut off mid-Apply, comes back with the steps saved so far and carries on from the first pending one on Retry', async () => {
    threeWaltzTickets();
    const session = await openWaltz();
    const started = await apply(session, await preview(session, mergeThree(session)));
    // VS Code closed after the third step was saved.
    const cut = restart({ ...session, working: started.reports[2].working });
    expect(stepsOf(cut).filter(s => s.endsWith('done'))).toEqual(['survivor-rewrite PROJ-12: done', 'survivor-comment PROJ-12: done', 'link PROJ-15: done']);
    expect(mergeView(cut)!.actions).toEqual(['retry', 'stop']);

    const resumed = (await apply(cut, await preview(cut, { type: 'merge-retry' }))).session;
    expect(mergeView(resumed)!.state).toBe('awaiting-close');
    // The steps Jira already has are not written twice.
    expect(jira.comments['PROJ-12']).toHaveLength(1);
    expect(jira.links.map(l => l.from)).toEqual(['PROJ-15', 'PROJ-18']);
  });

  it('started again after a rebuild, skips the comment, link and close steps Jira already shows as done', async () => {
    threeWaltzTickets();
    jira.failTransitionFor.add('PROJ-18');
    let first = await openWaltz();
    first = (await apply(first, await preview(first, mergeThree(first)))).session;
    first = act(first, { type: 'merge-close-target', issueType: 'Bug', option: 'status:Closed' });
    first = (await apply(first, await preview(first, { type: 'merge-close' }))).session;
    expect(mergeView(first)!.state).toBe('failed');
    expect(jira.tickets['PROJ-15'].status).toBe('Closed');

    // The stored format changed: the board is opened again from the report, without the run.
    jira.failTransitionFor.clear();
    let session = await openWaltz();
    expect(mergeView(session)).toBeUndefined();
    session = (await apply(session, await preview(session, { type: 'merge-start', ids: ['PROJ-15', 'PROJ-18'], keep: 'PROJ-12' }))).session;

    const notes = Object.fromEntries(mergeView(session)!.steps.map(s => [`${s.kind} ${s.key}`, `${s.status}${s.note ? ` (${s.note})` : ''}`]));
    expect(notes).toMatchObject({
      'survivor-comment PROJ-12': 'done (already commented)',
      'link PROJ-15': 'done (already linked)',
      'link PROJ-18': 'done (already linked)',
      'close PROJ-15': 'done (already resolved)',
      'close PROJ-18': 'pending',
    });
    expect(jira.comments['PROJ-12']).toHaveLength(1);
    expect(jira.links).toHaveLength(2);
    expect(mergeView(session)!.question!.groups.map(g => g.tickets)).toEqual([['PROJ-18']]);
  });
});

describe('a Veracode ticket merge (close mode)', () => {
  it('does not move a flaw the report no longer lists: the kept ticket stays as it is and the closed source names the flaw', async () => {
    // Flaws 101 and 102 share a file and fold into one row; PROJ-1 is newer, so it is the row's ticket.
    jira.tickets = {
      'PROJ-1': { labels: ['veracode', 'veracode-issue-101', 'veracode-issue-102'], summary: 'Foo ticket', status: 'Open', updated: 't1', created: '2026-05-01T09:00:00.000+0000' },
      'PROJ-2': { labels: ['veracode', 'veracode-issue-101', 'veracode-issue-999'], summary: 'Foo older ticket', status: 'Open', updated: 't1', created: '2026-01-01T09:00:00.000+0000' },
    };
    let session = await open(recipe('veracode', writeVeracode([{ id: '101', file: 'Foo.java' }, { id: '102', file: 'Foo.java', line: 20 }])));
    const row = rowFor(session, 'PROJ-1');

    const opening = await preview(session, { type: 'merge-start', ids: [row, 'PROJ-2'], keep: row });
    expect(opening.risky).toBe(true);
    expect(opening.lines).toContainEqual({ target: 'PROJ-2', change: 'Not moved, no longer in the report (named in the comment on PROJ-2): 999' });
    expect(opening.lines).toContainEqual({ target: 'PROJ-1', change: 'Stays as it is: PROJ-2 has no flaws PROJ-1 lacks' });

    session = (await apply(session, opening)).session;
    expect(stepsOf(session)).toEqual(['link PROJ-2: done', 'source-comment PROJ-2: done', 'close PROJ-2: pending']);
    session = act(session, { type: 'merge-close-target', issueType: 'Bug', option: 'status:Closed' });
    session = (await apply(session, await preview(session, { type: 'merge-close' }))).session;

    expect(jira.updateIssueCalls).toEqual([]);
    expect(jira.tickets['PROJ-1'].labels).not.toContain('veracode-issue-999');
    expect(jira.links).toEqual([{ from: 'PROJ-2', to: 'PROJ-1', type: 'Duplicate' }]);
    expect(jira.comments['PROJ-2'][0]).toContain('Not copied (no longer in the report): 999.');
    expect(jira.transitions).toEqual([{ key: 'PROJ-2', to: 'Closed', resolution: 'Duplicate' }]);
    // The kept ticket was only linked: its rows keep their own decision.
    expect(session.working.writes.tickets['PROJ-1']).toMatchObject({ commentOnly: true });
    expect(session.working.writes.tickets['PROJ-2']).toEqual({ updated: jira.tickets['PROJ-2'].updated });
    expect(mergeView(session)!.state).toBe('finished');
  });
});

describe('a ticket merge interrupted by a restart', () => {
  it('fails a step, comes back, retries, closes after the answers and, once acknowledged, leaves Already ticketed on the fresh reading', async () => {
    threeWaltzTickets();
    jira.failLinkFor.add('PROJ-18');
    let session = await openWaltz();
    session = (await apply(session, await preview(session, mergeThree(session)))).session;
    expect(mergeView(session)!.state).toBe('failed');

    // VS Code closes and opens again.
    session = restart(session);
    jira.failLinkFor.clear();
    session = (await apply(session, await preview(session, { type: 'merge-retry' }))).session;
    expect(mergeView(session)!.state).toBe('awaiting-close');
    session = act(session, { type: 'merge-close-target', issueType: 'Bug', option: 'status:Closed' });
    const finished = await apply(session, await preview(session, { type: 'merge-close' }));
    session = finished.session;
    expect(mergeView(session)!.state).toBe('finished');
    expect(view(session).finished).toBe(false);

    // Already ticketed had no unfinished choices, so it took the fresh reading at once: every row now points at the kept ticket.
    expect(session.working.outOfDate).toEqual([]);
    const ticketed = session.derived.data.review.allRows.filter(r => r.existingTicketKey !== null);
    expect(ticketed.map(r => r.target?.key)).toEqual(['PROJ-12', 'PROJ-12', 'PROJ-12']);

    session = act(session, { type: 'merge-acknowledge' });
    expect(mergeView(session)).toBeUndefined();
    // Once acknowledged, a new merge can start.
    expect(await planned(session, { type: 'merge-start', ids: ['PROJ-18'], keep: 'PROJ-12' })).toMatchObject({ ok: true });
  });

  it('a finished merge marks Already ticketed out of date when it holds an unfinished choice and someone else changed it', async () => {
    const libqux = comp('libqux:5.0');
    threeWaltzTickets();
    jira.tickets['PROJ-30'] = waltzTicket(libqux, { summary: 'libqux ticket' });
    let session = await open(recipe('waltz', writeWaltz([libfoo, libbar, libbaz, libqux])));
    const quxRow = session.derived.data.review.allRows.find(r => r.id === rowFor(session, 'PROJ-30'))!;
    const other = (quxRow.allowedActions ?? []).find(a => a !== (quxRow.action ?? 'leave'))!;
    session = act(session, { type: 'ticketed-action', id: quxRow.id, action: other });

    session = (await apply(session, await preview(session, mergeThree(session)))).session;
    jira.tickets['PROJ-30'].labels = [...jira.tickets['PROJ-30'].labels, 'hand-added'];
    jira.touch('PROJ-30');
    session = act(session, { type: 'merge-close-target', issueType: 'Bug', option: 'status:Closed' });
    session = (await apply(session, await preview(session, { type: 'merge-close' }))).session;

    expect(mergeView(session)!.state).toBe('finished');
    expect(session.working.outOfDate).toEqual(['ticketed']);
  });
});
