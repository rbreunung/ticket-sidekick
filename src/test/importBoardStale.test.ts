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
import { registerKind } from '../sessions/boardKind';
import { SessionManager } from '../sessions/sessionManager';
import { SessionStore } from '../sessions/sessionStore';
import type { Session, WritePlan } from '../sessions/sessionTypes';
import { MockJiraClient } from './mocks/MockJiraClient';

// The Stale tab of the import board: the developer marks open tickets whose findings are gone from
// the report, picks per issue type where they go (a cleanup rule or a reachable status) and, for a
// closing status without a rule resolution, which resolution to set; one Apply then moves every
// issue type that has a target.

interface Ticket {
  labels: string[];
  issueType: string;
  status: string;
  resolved?: boolean;
  updated: string;
}

/** Where each transition of the test workflow leads. */
const TRANSITIONS: Record<string, string> = { '11': 'In Progress', '21': 'Done', '31': 'Closed' };

class FakeJira extends MockJiraClient {
  tickets: Record<string, Ticket> = {};
  private writes = 0;

  private issue(key: string): JiraIssue {
    const t = this.tickets[key];
    return {
      id: key, key,
      fields: {
        labels: t.labels, summary: `Ticket ${key}`, status: { name: t.status },
        resolution: t.resolved ? { name: 'Fixed' } : null, created: '2026-01-01T09:00:00.000+0000', duedate: null,
        updated: t.updated, issuetype: { name: t.issueType }, fixVersions: [], description: '',
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

  override async executeTransition(issueKey: string, transitionId: string, fields?: Record<string, unknown>): Promise<void> {
    await super.executeTransition(issueKey, transitionId, fields);
    const t = this.tickets[issueKey];
    t.status = TRANSITIONS[transitionId];
    if (t.status === 'Done' || t.status === 'Closed') t.resolved = true;
    this.writes += 1;
    t.updated = `w${this.writes}`;
  }
}

const REPORT = `<?xml version="1.0" encoding="UTF-8"?>
<detailedreport xmlns="https://analysiscenter.veracode.com/schema/2.0/detailedreport" report_format_version="1.5" app_name="App">
  <severity level="4">
    <category categoryid="18" categoryname="Credentials Management" pcirelated="true">
      <desc><para text="Hard-coded credentials."/></desc>
      <recommendations><para text="Use a secrets manager."/></recommendations>
      <cwe cweid="798" cwename="Use of Hard-coded Credentials">
        <description><para text="Risky."/></description>
        <staticflaws>
          <flaw severity="4" categoryname="Credentials Management" count="1" issueid="101" module="App.war"
                type="Hard-coded Password" description="A hard-coded password in A.java."
                cweid="798" remediationeffort="2" exploitLevel="3" categoryid="18"
                date_first_occurrence="2026-04-20T14:00:00.000-0000" remediation_status="New"
                sourcefile="A.java" line="10" sourcefilepath="com/example/" mitigation_status="none"/>
        </staticflaws>
      </cwe>
    </category>
  </severity>
</detailedreport>`;

let dir: string;
let jira: FakeJira;
let deps: ImportDeps;

const MB = 20 * 1024 * 1024;

beforeEach(async () => {
  dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ts-import-stale-'));
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
  // Bug: Open → In Progress → Done; Task: Open → Closed. Story has no discovered workflow.
  fs.writeFileSync(path.join(dir, '.jira-workflow-cache.json'), JSON.stringify({
    PROJ: {
      Bug: { discovered: '2026-01-01', graph: { Open: [{ id: '11', name: 'Start', to: 'In Progress' }], 'In Progress': [{ id: '21', name: 'Finish', to: 'Done' }] } },
      Task: { discovered: '2026-01-01', graph: { Open: [{ id: '31', name: 'Close', to: 'Closed' }] } },
    },
  }));
  fs.writeFileSync(path.join(dir, '.jira-templates.json'), JSON.stringify({
    templates: [],
    cleanupRules: [{ name: 'Close fixed bugs', project: 'PROJ', issueType: 'Bug', targetState: 'Done', resolution: 'Fixed' }],
  }));
  fs.writeFileSync(path.join(dir, 'report.xml'), REPORT);
});

afterEach(async () => {
  await fs.promises.rm(dir, { recursive: true, force: true });
});

/** An open ticket for a flaw the report no longer lists. */
const staleTicket = (flaw: string, issueType: string): Ticket => ({
  labels: ['veracode', `veracode-issue-${flaw}`], issueType, status: 'Open', updated: 't1',
});

const recipe = (): ImportRecipe => ({ kind: 'veracode', projectKey: 'PROJ', reportPath: path.join(dir, 'report.xml'), templateName: 'Security bug', issueType: 'Bug' });

type ImportSession = Session<ImportRecipe, ImportData, ImportWorking>;

async function open(): Promise<ImportSession> {
  const validated = await importKind.validate(recipe(), deps);
  if (!validated.ok) throw new Error(validated.reason);
  return {
    id: importSessionId(validated.recipe), kind: 'import', formatVersion: importKind.formatVersion, revision: 1, createdAt: 0, lastUsedAt: 0,
    recipe: validated.recipe, derived: await importKind.read(validated.recipe, deps), working: importKind.initialWorking(validated.recipe), conflicts: [],
  };
}

function act(session: ImportSession, action: unknown): ImportSession {
  const reduced = importKind.reduce(session, action as never);
  if (!reduced.ok) throw new Error(reduced.reason);
  return { ...session, working: reduced.working };
}

function refused(session: ImportSession, action: unknown): string {
  const reduced = importKind.reduce(session, action as never);
  if (reduced.ok) throw new Error('expected a refusal');
  return reduced.reason;
}

function planOf(session: ImportSession): WritePlan {
  const planned = importKind.plan!(session, { type: 'close-stale' } as never);
  if (!planned.ok) throw new Error(planned.reason);
  return planned.plan;
}

interface StaleGroupView {
  issueType: string;
  targetOptions: Array<{ id: string; label: string; needsResolution: boolean }>;
  target: string | null;
  resolutionOptions: Array<{ id: string; label: string }>;
  resolution: string | null;
}
interface StaleExt { groups: StaleGroupView[]; selectable: string[] }

const staleView = (session: ImportSession): ImportView => importKind.view(act(session, { type: 'tab', tab: 'stale' }));
const ext = (session: ImportSession) => staleView(session).ext.stale as StaleExt;
const group = (session: ImportSession, issueType: string) => ext(session).groups.find(g => g.issueType === issueType)!;

describe('closing stale tickets', () => {
  it('closes one marked Bug to Done with resolution Fixed after the native confirmation, because the write closes a ticket', async () => {
    jira.tickets = { 'PROJ-9': staleTicket('999', 'Bug') };
    const storeDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ts-import-stale-store-'));
    const asked: string[] = [];
    try {
      const manager = new SessionManager({
        store: new SessionStore(storeDir), kinds: [registerKind(importKind, () => deps)], now: () => 1_000,
        confirm: async plan => { asked.push(plan.title); return true; }, saveFile: async () => true,
      });
      const opened = await manager.open('import', recipe());
      if (!opened.ok) throw new Error(opened.reason);
      let state = await manager.state('import', opened.id);
      while (state.status === 'building' || state.status === 'checking') state = await manager.state('import', opened.id, state.tick, 2000);
      for (const action of [
        { type: 'tab', tab: 'stale' },
        { type: 'toggle-stale', keys: ['PROJ-9'] },
        { type: 'stale-target', issueType: 'Bug', target: 'status:Done' },
        { type: 'stale-resolution', issueType: 'Bug', resolution: 'resolution:Fixed' },
      ]) state = await manager.action('import', opened.id, state.revision, action);

      const preview = await manager.preview('import', opened.id, state.revision, { type: 'close-stale' });
      expect(preview.risky).toBe(true);
      expect(preview.lines).toEqual([{ target: 'PROJ-9', change: 'Status: Open → Done, resolution Fixed' }]);

      const applied = await manager.apply('import', opened.id, preview.planId);
      expect(asked).toHaveLength(1);
      expect(applied.results).toEqual([{ target: 'PROJ-9', outcome: 'done' }]);
      expect(jira.executeTransitionCalls).toEqual([
        { issueKey: 'PROJ-9', transitionId: '11', fields: undefined },
        { issueKey: 'PROJ-9', transitionId: '21', fields: { resolution: { name: 'Fixed' } } },
      ]);
      const session = (await manager.read('import', opened.id)) as ImportSession;
      expect(session.working.writes.tickets['PROJ-9']).toEqual({ updated: 'w2' });
    } finally {
      await fs.promises.rm(storeDir, { recursive: true, force: true });
    }
  });

  it('closes a Bug group and a Task group with their own targets in one Apply, reporting each ticket as it finishes', async () => {
    jira.tickets = { 'PROJ-9': staleTicket('998', 'Bug'), 'PROJ-10': staleTicket('999', 'Task') };
    let session = await open();
    session = act(session, { type: 'toggle-stale', keys: ['PROJ-9', 'PROJ-10'] });
    session = act(session, { type: 'stale-target', issueType: 'Bug', target: 'rule:Close fixed bugs' });
    session = act(session, { type: 'stale-target', issueType: 'Task', target: 'status:Closed' });
    session = act(session, { type: 'stale-resolution', issueType: 'Task', resolution: "resolution:Won't Fix" });

    const plan = planOf(session);
    expect(plan.lines).toEqual([
      { target: 'PROJ-9', change: 'Status: Open → Done, resolution Fixed' },
      { target: 'PROJ-10', change: "Status: Open → Closed, resolution Won't Fix" },
    ]);
    expect(plan.risky).toBe(true);

    const reports: Array<{ done: number; total: number; written: string[] }> = [];
    const applied = await importKind.apply!(session, plan, deps, async r => {
      reports.push({ done: r.done, total: r.total, written: Object.keys(r.working.writes.tickets) });
    });
    expect(applied.results).toEqual([{ target: 'PROJ-9', outcome: 'done' }, { target: 'PROJ-10', outcome: 'done' }]);
    expect(reports).toEqual([
      { done: 1, total: 2, written: ['PROJ-9'] },
      { done: 2, total: 2, written: ['PROJ-9', 'PROJ-10'] },
    ]);
    expect(jira.tickets['PROJ-9']).toMatchObject({ status: 'Done', resolved: true });
    expect(jira.tickets['PROJ-10']).toMatchObject({ status: 'Closed', resolved: true });
    expect(jira.executeTransitionCalls.at(-1)).toEqual({ issueKey: 'PROJ-10', transitionId: '31', fields: { resolution: { name: "Won't Fix" } } });
    expect(applied.working.writes.tickets).toEqual({ 'PROJ-9': { updated: 'w2' }, 'PROJ-10': { updated: 'w3' } });
  });

  it('shows a ticket without a discovered workflow but does not let it be selected', async () => {
    jira.tickets = { 'PROJ-9': staleTicket('998', 'Bug'), 'PROJ-11': staleTicket('999', 'Story') };
    const session = await open();
    const v = staleView(session);
    expect(v.stale!.rows.map(r => r.key)).toEqual(['PROJ-9', 'PROJ-11']);
    expect(v.stale!.rows[1].note).toMatch(/no workflow cache for PROJ\/Story/);
    expect(ext(session).selectable).toEqual(['PROJ-9']);
    expect(refused(session, { type: 'toggle-stale', keys: ['PROJ-11'] })).toMatch(/PROJ-11/);
  });

  it('refuses a close while the Stale tab is out of date, whatever the page shows', async () => {
    jira.tickets = { 'PROJ-9': staleTicket('998', 'Bug') };
    let session = await open();
    session = act(session, { type: 'toggle-stale', keys: ['PROJ-9'] });
    session = act(session, { type: 'stale-target', issueType: 'Bug', target: 'rule:Close fixed bugs' });
    expect(planOf(session).lines).toHaveLength(1);
    const outdated = { ...session, working: { ...session.working, outOfDate: ['stale' as const] } };
    expect(importKind.plan!(outdated, { type: 'close-stale' } as never)).toEqual({ ok: false, reason: 'The Stale tab is out of date. Refresh it first.' });
  });

  it('leaves a group without a target out of the plan and says so', async () => {
    jira.tickets = { 'PROJ-9': staleTicket('998', 'Bug'), 'PROJ-10': staleTicket('999', 'Task') };
    let session = await open();
    session = act(session, { type: 'toggle-stale', keys: ['PROJ-9', 'PROJ-10'] });
    const none = importKind.plan!(session, { type: 'close-stale' } as never);
    expect(none).toMatchObject({ ok: false });

    session = act(session, { type: 'stale-target', issueType: 'Bug', target: 'rule:Close fixed bugs' });
    const plan = planOf(session);
    expect(plan.lines.map(l => l.target)).toEqual(['PROJ-9']);
    expect(plan.title).toMatch(/Task: no target status picked/);
  });

  it('asks for a resolution only for a closing target without a rule resolution', async () => {
    jira.tickets = { 'PROJ-9': staleTicket('999', 'Bug') };
    let session = await open();
    session = act(session, { type: 'toggle-stale', keys: ['PROJ-9'] });
    expect(group(session, 'Bug').targetOptions).toEqual([
      { id: 'rule:Close fixed bugs', label: 'Close fixed bugs → Done', needsResolution: false },
      { id: 'status:Done', label: 'Done', needsResolution: true },
      { id: 'status:In Progress', label: 'In Progress', needsResolution: false },
    ]);

    session = act(session, { type: 'stale-target', issueType: 'Bug', target: 'status:Done' });
    expect(group(session, 'Bug').resolutionOptions.map(o => o.id)).toEqual([
      'none', 'resolution:Fixed', "resolution:Won't Fix", 'resolution:Duplicate', 'resolution:Done', 'resolution:Cannot Reproduce',
    ]);
    const waiting = importKind.plan!(session, { type: 'close-stale' } as never);
    expect(waiting).toMatchObject({ ok: false });
    if (!waiting.ok) expect(waiting.reason).toMatch(/Bug: no resolution picked/);
    expect(refused(session, { type: 'stale-resolution', issueType: 'Bug', resolution: 'Fixed' })).toBeTruthy();

    session = act(session, { type: 'stale-target', issueType: 'Bug', target: 'status:In Progress' });
    expect(group(session, 'Bug').resolutionOptions).toEqual([]);
    expect(planOf(session).lines).toEqual([{ target: 'PROJ-9', change: 'Status: Open → In Progress' }]);
    // One ticket moved to a status that does not close it asks no native confirmation.
    expect(planOf(session).risky).toBe(false);
    expect(refused(session, { type: 'stale-resolution', issueType: 'Bug', resolution: 'resolution:Fixed' })).toBeTruthy();
  });

  it('moves at most 50 tickets in one Apply and says how many remain', async () => {
    for (let n = 1; n <= 52; n++) jira.tickets[`PROJ-${100 + n}`] = staleTicket(String(900 + n), 'Bug');
    let session = await open();
    session = act(session, { type: 'toggle-stale', keys: Object.keys(jira.tickets) });
    session = act(session, { type: 'stale-target', issueType: 'Bug', target: 'rule:Close fixed bugs' });
    const plan = planOf(session);
    expect(plan.lines).toHaveLength(50);
    expect(plan.title).toMatch(/2 selected ticket\(s\) remain for the next Apply/);
  });
});
