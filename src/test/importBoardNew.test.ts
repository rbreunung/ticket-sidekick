import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { importKind, type ImportView, type ImportWorking } from '../boards/import/kind';
import { importJiraDeps } from '../boards/import/jiraDeps';
import { createEmailDescriptor } from '../imports/email';
import type { ImportData, ImportDeps } from '../boards/import/read';
import { importSessionId, type ImportRecipe } from '../boards/import/recipe';
import { createVeracodeDescriptor } from '../imports/veracode';
import { createWaltzDescriptor } from '../imports/waltz';
import type { JiraCreatedIssue, JiraIssue, JiraSearchResult } from '../jira/IJiraClient';
import type { ApplyProgressReport } from '../sessions/boardKind';
import type { Session, WritePlan } from '../sessions/sessionTypes';
import { JiraApiError } from '../utils/apiError';
import { buildGroupSummary, type VeracodeFlaw } from '../utils/veracodeReport';
import { MockJiraClient } from './mocks/MockJiraClient';

// The New tab of the import board: the developer picks which new findings to create, merges some
// into one ticket or adds them to an existing ticket, and applies. Each ticket written is saved as
// it is done, so an interrupted Apply leaves only the rest for the next one.

interface Ticket {
  labels: string[];
  summary?: string;
  updated: string;
  duedate?: string | null;
  description?: string;
  resolved?: boolean;
}

class FakeJira extends MockJiraClient {
  tickets: Record<string, Ticket> = {};
  /** Answer a create or update carrying a Due Date with the 400 Jira gives for a field missing from the screen. */
  refuseDueDate = false;
  /** Every create sent to Jira, refused or not. */
  createAttempts = 0;
  private nextKey = 100;
  private tick = 0;

  private issue(key: string): JiraIssue {
    const t = this.tickets[key];
    return {
      id: key, key,
      fields: {
        labels: t.labels, summary: t.summary ?? `Ticket ${key}`, status: { name: 'Open' },
        resolution: t.resolved ? { name: 'Fixed' } : null, created: '2026-01-01T09:00:00.000+0000', duedate: t.duedate ?? null,
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
      keys = all.filter(k => this.tickets[k].labels.includes(marker));
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

  private refuse(fields: Record<string, unknown> | undefined): void {
    if (this.refuseDueDate && fields && 'duedate' in fields) {
      throw new JiraApiError('Jira answered 400', 400, 'https://jira.example.com/rest/api/2/issue', JSON.stringify({ errors: { duedate: 'Field cannot be set.' } }));
    }
  }

  override async createIssue(projectKey: string, summary: string, issueType: string, additionalFields?: Record<string, unknown>): Promise<JiraCreatedIssue> {
    this.createAttempts++;
    this.refuse(additionalFields);
    this.createIssueCalls.push({ projectKey, summary, issueType, additionalFields });
    const key = `${projectKey}-${this.nextKey++}`;
    this.tickets[key] = { labels: (additionalFields?.labels as string[]) ?? [], summary, updated: `c${++this.tick}` };
    return { id: key, key, self: '' } as JiraCreatedIssue;
  }

  override async updateIssue(issueKey: string, fields: Record<string, unknown>): Promise<void> {
    this.refuse(fields);
    await super.updateIssue(issueKey, fields);
    this.touch(issueKey);
  }

  override async addComment(issueKey: string, body: string): Promise<void> {
    await super.addComment(issueKey, body);
    this.touch(issueKey);
  }

  private touch(key: string): void {
    if (this.tickets[key]) this.tickets[key].updated = `u${++this.tick}`;
  }
}

interface Flaw { id: string; file: string; firstFound?: string }

function veracodeXml(flaws: Flaw[]): string {
  const blocks = flaws.map((f, n) => `
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
                date_first_occurrence="${f.firstFound ?? '2026-04-20T14:00:00.000-0000'}" remediation_status="New"
                sourcefile="${f.file}" line="${10 + n}" sourcefilepath="com/example/" mitigation_status="none"/>
        </staticflaws>
      </cwe>
    </category>
  </severity>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<detailedreport xmlns="https://analysiscenter.veracode.com/schema/2.0/detailedreport" report_format_version="1.5" app_name="App">${blocks}
</detailedreport>`;
}

const MB = 20 * 1024 * 1024;
/** First found 2026-04-20, severity High, 30 days for High: due 2026-05-20. */
const SLA_DUE = '2026-05-20';

let dir: string;
let jira: FakeJira;
let deps: ImportDeps;

beforeEach(async () => {
  dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ts-import-new-'));
  jira = new FakeJira();
  fs.writeFileSync(path.join(dir, '.jira-templates.json'), JSON.stringify({
    templates: [{ name: 'Security bug', issueType: 'Bug', defaultFields: { priority: { name: 'High' }, labels: ['security'] } }],
  }));
  const veracode = createVeracodeDescriptor({
    filter: () => ({ minSeverity: 3, includeStatuses: ['New', 'Open', 'Reopened'], maxReportBytes: MB }),
    slaDays: () => ({ High: 30 }),
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
    now: () => 1_000,
  });
});

afterEach(async () => {
  await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

type ImportSession = Session<ImportRecipe, ImportData, ImportWorking>;

async function openVeracode(flaws: Flaw[]): Promise<ImportSession> {
  const file = path.join(dir, 'report.xml');
  fs.writeFileSync(file, veracodeXml(flaws));
  const r: ImportRecipe = { kind: 'veracode', projectKey: 'PROJ', reportPath: file, templateName: 'Security bug', issueType: 'Bug' };
  const validated = await importKind.validate(r, deps);
  if (!validated.ok) throw new Error(validated.reason);
  return {
    id: importSessionId(r), kind: 'import', formatVersion: importKind.formatVersion, revision: 1, createdAt: 0, lastUsedAt: 0,
    recipe: validated.recipe, derived: await importKind.read(validated.recipe, deps), working: importKind.initialWorking(validated.recipe),
  };
}

const flaws = (...ids: string[]): Flaw[] => ids.map(id => ({ id, file: `File${id}.java` }));
const view = (session: ImportSession): ImportView => importKind.view(session);

/** The New row id of a flaw, as the page sends it. */
function rowId(session: ImportSession, flaw: string): string {
  const row = view(session).new!.rows.find(r => r.ref === `Flaw ${flaw}`);
  if (!row) throw new Error(`No New row for flaw ${flaw}`);
  return row.id;
}

function act(session: ImportSession, action: unknown): ImportSession {
  const reduced = importKind.reduce(session, action as never);
  if (!reduced.ok) throw new Error(reduced.reason);
  return { ...session, working: reduced.working };
}

function plan(session: ImportSession, action: unknown): WritePlan {
  const planned = importKind.plan!(session, action as never);
  if (!planned.ok) throw new Error(planned.reason);
  return planned.plan;
}

async function apply(session: ImportSession, p: WritePlan, progress?: (r: ApplyProgressReport<ImportWorking>) => Promise<void>) {
  const applied = await importKind.apply!(session, p, deps, progress);
  return { applied, session: { ...session, derived: applied.derived, working: applied.working } };
}

/** Includes only the named flaws' rows. */
function only(session: ImportSession, ...flawIds: string[]): ImportSession {
  const none = act(session, { type: 'new-include', ids: 'all', included: false });
  return act(none, { type: 'new-include', ids: flawIds.map(f => rowId(session, f)), included: true });
}

function sourceGroup(session: ImportSession, flaw: string): VeracodeFlaw[] {
  const row = session.derived.data.review.allRows.find(r => 'issueIds' in r && r.issueIds.includes(flaw))!;
  return (row as unknown as { sourceGroup: VeracodeFlaw[] }).sourceGroup;
}

describe('selecting New rows', () => {
  it('leaves one row or all rows out of the create and takes them back in', async () => {
    let session = await openVeracode(flaws('101', '102', '103'));
    session = act(session, { type: 'new-include', ids: [rowId(session, '102')], included: false });
    expect(view(session).new!.rows.map(r => [r.ref, r.included])).toEqual([['Flaw 101', true], ['Flaw 102', false], ['Flaw 103', true]]);

    session = act(session, { type: 'new-include', ids: 'all', included: false });
    expect(view(session).new!.rows.every(r => !r.included)).toBe(true);
    session = act(session, { type: 'new-include', ids: 'all', included: true });
    expect(view(session).new!.rows.every(r => r.included)).toBe(true);
    expect(session.working.choices.excluded).toEqual([]);
  });
});

describe('creating tickets for New rows', () => {
  it('creates one ticket per selected Veracode row with the template fields, the labels and the SLA Due Date', async () => {
    const session = await openVeracode(flaws('101', '102', '103'));
    const p = plan(session, { type: 'new-create' });
    expect(p.lines).toHaveLength(3);

    const { applied, session: after } = await apply(session, p);

    expect(jira.createIssueCalls).toHaveLength(3);
    for (const [n, call] of jira.createIssueCalls.entries()) {
      const id = ['101', '102', '103'][n];
      expect(call.projectKey).toBe('PROJ');
      expect(call.issueType).toBe('Bug');
      expect(call.additionalFields!.priority).toEqual({ name: 'High' });
      expect(call.additionalFields!.labels).toEqual(expect.arrayContaining(['security', 'veracode', `veracode-issue-${id}`]));
      expect(call.additionalFields!.duedate).toBe(SLA_DUE);
    }
    expect(applied.results.map(r => r.outcome)).toEqual(['done', 'done', 'done']);
    expect(after.working.writes.created).toEqual([
      { dedupKeys: ['101'], key: 'PROJ-100' }, { dedupKeys: ['102'], key: 'PROJ-101' }, { dedupKeys: ['103'], key: 'PROJ-102' },
    ]);
    // The created rows show their ticket and are not offered again.
    expect(view(after).new!.rows.map(r => r.created)).toEqual(['PROJ-100', 'PROJ-101', 'PROJ-102']);
    expect(importKind.plan!(after, { type: 'new-create' } as never)).toEqual({ ok: false, reason: expect.stringMatching(/nothing/i) });
  });

  it('drops a Due Date Jira refuses, creates the ticket once more without it and says so', async () => {
    const session = only(await openVeracode(flaws('101', '102')), '101');
    jira.refuseDueDate = true;

    const { applied } = await apply(session, plan(session, { type: 'new-create' }));

    expect(jira.createAttempts).toBe(2);
    expect(jira.createIssueCalls).toHaveLength(1);
    expect(jira.createIssueCalls[0].additionalFields).not.toHaveProperty('duedate');
    expect(applied.results).toEqual([{ target: 'Flaw 101: PROJ-100', outcome: 'done', reason: expect.stringContaining('Due Date') }]);
  });

  it('creates one ticket for two merged rows, with the folded title and description', async () => {
    let session = await openVeracode(flaws('101', '102', '103'));
    session = act(session, { type: 'new-merge', ids: [rowId(session, '102'), rowId(session, '103')] });
    expect(view(session).new!.rows.map(r => r.merge)).toEqual([undefined, 1, 1]);
    session = act(session, { type: 'new-include', ids: [rowId(session, '101')], included: false });

    const p = plan(session, { type: 'new-create' });
    expect(p.lines).toHaveLength(1);
    expect(p.risky).toBe(false);
    const { applied, session: after } = await apply(session, p);

    expect(jira.createIssueCalls).toHaveLength(1);
    const call = jira.createIssueCalls[0];
    expect(call.summary).toBe(buildGroupSummary([...sourceGroup(session, '102'), ...sourceGroup(session, '103')]));
    expect(call.summary).not.toBe(buildGroupSummary(sourceGroup(session, '102')));
    expect(String(call.additionalFields!.description)).toMatch(/102[\s\S]*103/);
    expect(call.additionalFields!.labels).toEqual(expect.arrayContaining(['veracode-issue-102', 'veracode-issue-103']));
    expect(applied.results).toEqual([{ target: 'Flaw 102, 103: PROJ-100', outcome: 'done' }]);
    expect(after.working.writes.created).toEqual([{ dedupKeys: ['102', '103'], key: 'PROJ-100' }]);
  });

  it('a Refresh after the merged create does not report the merge as dropped', async () => {
    let session = await openVeracode(flaws('101', '102'));
    session = act(session, { type: 'new-merge', ids: [rowId(session, '101'), rowId(session, '102')] });
    session = (await apply(session, plan(session, { type: 'new-create' }))).session;

    const fresh = await importKind.read(session.recipe, deps);
    const refreshed = importKind.reconcile(session, fresh, 'refresh');
    expect(refreshed.working.dropped).toEqual([]);
    expect(refreshed.working.choices.merges).toEqual([]);
  });

  it('fails one odd row alone and still creates the other tickets', async () => {
    const session = await openVeracode(flaws('101', '102', '103'));
    // Building the fields of Flaw 102 throws, as an unexpected report value could.
    const base = deps;
    const veracode = base.descriptors().veracode;
    deps = {
      ...base,
      descriptors: () => ({
        ...base.descriptors(),
        veracode: {
          ...veracode,
          buildTicketFields: ((row: { issueIds?: string[] }, ...rest: unknown[]) => {
            if (row.issueIds?.includes('102')) throw new Error('Unexpected value in the report row');
            return (veracode.buildTicketFields as (...a: unknown[]) => unknown)(row, ...rest);
          }) as typeof veracode.buildTicketFields,
        },
      }),
    };
    const { applied, session: after } = await apply(session, plan(session, { type: 'new-create' }));
    deps = base;

    expect(applied.results.map(r => r.outcome)).toEqual(['done', 'failed', 'done']);
    expect(applied.results[1]).toMatchObject({ target: 'Flaw 102', reason: 'Unexpected value in the report row' });
    expect(after.working.writes.created.map(c => c.dedupKeys)).toEqual([['101'], ['103']]);
  });

  it('puts the rows of an unmerged merge back as their own tickets', async () => {
    let session = await openVeracode(flaws('101', '102'));
    session = act(session, { type: 'new-merge', ids: [rowId(session, '101'), rowId(session, '102')] });
    session = act(session, { type: 'new-unmerge', id: rowId(session, '102') });
    expect(session.working.choices.merges).toEqual([]);
    expect(plan(session, { type: 'new-create' }).lines).toHaveLength(2);
  });

  it('previews 50 of 72 selected rows and names the 22 left for the next Apply', async () => {
    const ids = Array.from({ length: 72 }, (_, n) => String(1000 + n));
    const session = await openVeracode(flaws(...ids));

    const p = plan(session, { type: 'new-create' });

    expect(p.lines).toHaveLength(50);
    expect(p.lines[0].target).toBe('Flaw 1000');
    expect(p.lines[49].target).toBe('Flaw 1049');
    expect(p.title).toMatch(/22 .*remain.*next Apply/);
    expect(view(session).ext.new).toMatchObject({ toCreate: 72, perApply: 50 });
  });

  it('asks for no native confirmation, not even for a plan over two or more tickets', async () => {
    const session = await openVeracode(flaws('101', '102'));
    expect(plan(session, { type: 'new-create' }).risky).toBe(false);
    expect(plan(only(session, '102'), { type: 'new-create' }).risky).toBe(false);
  });

  it('keeps the tickets an interrupted create already made, and the next plan covers only the rest', async () => {
    const session = await openVeracode(flaws('101', '102', '103'));
    let saved: ImportWorking | undefined;
    let reports = 0;
    const progress = async (report: ApplyProgressReport<ImportWorking>) => {
      saved = report.working;
      if (++reports === 2) throw new Error('VS Code closed');
    };

    await expect(apply(session, plan(session, { type: 'new-create' }), progress)).rejects.toThrow('VS Code closed');

    expect(saved!.writes.created).toEqual([{ dedupKeys: ['101'], key: 'PROJ-100' }, { dedupKeys: ['102'], key: 'PROJ-101' }]);
    const restored = { ...session, working: saved! };
    expect(view(restored).new!.rows.map(r => r.created)).toEqual(['PROJ-100', 'PROJ-101', undefined]);
    expect(plan(restored, { type: 'new-create' }).lines.map(l => l.target)).toEqual(['Flaw 103']);
  });
});

describe('adding New rows to an existing ticket', () => {
  beforeEach(() => {
    jira.tickets['SEC-12'] = { labels: ['veracode', 'veracode-issue-108'], summary: 'Hard-coded password', updated: 't1' };
  });

  it('as a comment: adds the record labels and posts the folded comment', async () => {
    const session = await openVeracode(flaws('101', '104', '108'));
    const p = plan(session, { type: 'new-add', ids: [rowId(session, '104')], key: 'SEC-12', mode: 'comment' });
    expect(p.risky).toBe(false);
    expect(p.lines).toEqual([{ target: 'SEC-12', change: expect.stringMatching(/comment/i) }]);

    const { applied, session: after } = await apply(session, p);

    expect(jira.updateIssueCalls).toHaveLength(1);
    expect(JSON.stringify(jira.updateIssueCalls[0].fields)).toContain('veracode-issue-104');
    expect(jira.addCommentCalls).toHaveLength(1);
    expect(jira.addCommentCalls[0].issueKey).toBe('SEC-12');
    expect(jira.addCommentCalls[0].body).toContain('This Veracode finding was added to this ticket.');
    expect(jira.addCommentCalls[0].body).toContain('104');
    expect(applied.results).toEqual([{ target: 'Flaw 104: SEC-12', outcome: 'done' }]);
    expect(after.working.writes.created).toEqual([{ dedupKeys: ['104'], key: 'SEC-12' }]);
    expect(after.working.writes.tickets['SEC-12']).toEqual({ updated: jira.tickets['SEC-12'].updated, commentOnly: true });
    expect(view(after).ext.new).toMatchObject({ addedTo: { [rowId(session, '104')]: 'SEC-12' } });
    // The row left the create.
    expect(plan(after, { type: 'new-create' }).lines.map(l => l.target)).toEqual(['Flaw 101']);
  });

  it('a comment add leaves the target ticket\'s own Already-ticketed decision open, as the chat does', async () => {
    const session = await openVeracode(flaws('101', '104', '108'));
    const ticketedBefore = importKind.view({ ...session, working: { ...session.working, tab: 'ticketed', ticketedShow: 'all' } }).ticketed!.rows;
    const sec12 = ticketedBefore.find(r => r.ticket === 'SEC-12')!;
    expect(sec12.needsDecision).toBe(true);

    const { session: after } = await apply(session, plan(session, { type: 'new-add', ids: [rowId(session, '104')], key: 'SEC-12', mode: 'comment' }));

    const row = importKind.view({ ...after, working: { ...after.working, tab: 'ticketed', ticketedShow: 'all' } }).ticketed!.rows.find(r => r.ticket === 'SEC-12')!;
    expect(row.needsDecision).toBe(true);
    expect(row.written).toBe(false);
  });

  it('a comment add to a ticket the board already rewrote keeps that ticket settled', async () => {
    let session = await openVeracode(flaws('101', '104', '108'));
    // The board rewrote SEC-12 before.
    session = { ...session, working: { ...session.working, writes: { ...session.working.writes, tickets: { 'SEC-12': { updated: jira.tickets['SEC-12'].updated } } } } };

    const { session: after } = await apply(session, plan(session, { type: 'new-add', ids: [rowId(session, '104')], key: 'SEC-12', mode: 'comment' }));

    expect(after.working.writes.tickets['SEC-12'].commentOnly).toBeUndefined();
    const row = importKind.view({ ...after, working: { ...after.working, tab: 'ticketed', ticketedShow: 'all' } }).ticketed!.rows.find(r => r.ticket === 'SEC-12')!;
    expect(row.written).toBe(true);
  });

  it('as a rewrite: rebuilds the ticket from its findings and the added row, with the SLA Due Date', async () => {
    const session = await openVeracode(flaws('101', '104', '108'));
    const p = plan(session, { type: 'new-add', ids: [rowId(session, '104')], key: 'SEC-12', mode: 'rewrite' });

    const { applied } = await apply(session, p);

    expect(jira.updateIssueCalls).toHaveLength(1);
    const fields = jira.updateIssueCalls[0].fields;
    expect(fields.summary).toBe(buildGroupSummary([...sourceGroup(session, '108'), ...sourceGroup(session, '104')]));
    expect(String(fields.description)).toMatch(/108[\s\S]*104/);
    expect(fields.duedate).toBe(SLA_DUE);
    expect(jira.addCommentCalls.map(c => c.issueKey)).toEqual(['SEC-12']);
    expect(applied.results).toEqual([{ target: 'Flaw 104: SEC-12', outcome: 'done', reason: `Due Date set to ${SLA_DUE} from your SLA table` }]);
  });

  it('reads the target before the preview and warns that it is resolved and what a rewrite drops', async () => {
    jira.tickets['SEC-12'].resolved = true;
    // The report no longer holds flaw 108, which the ticket records.
    const session = await openVeracode(flaws('101', '104'));
    const action = { type: 'new-add', ids: [rowId(session, '104')], key: 'SEC-12', mode: 'rewrite' };

    const prepared = await importKind.prepare!(session, action as never, deps);
    const planned = importKind.plan!(session, action as never, prepared);

    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const changes = planned.plan.lines.map(l => l.change);
    expect(changes).toContain('Now: Hard-coded password (Open)');
    expect(changes).toContain('This ticket is resolved. You can still add to it, but nobody may be watching it.');
    expect(changes.some(c => /drops these findings[^]*108/.test(c))).toBe(true);
    expect(jira.updateIssueCalls).toHaveLength(0);
  });

  it('refuses the preview when the target ticket cannot be read', async () => {
    const session = await openVeracode(flaws('101'));
    const action = { type: 'new-add', ids: [rowId(session, '101')], key: 'SEC-99', mode: 'comment' };

    const prepared = await importKind.prepare!(session, action as never, deps);

    expect(importKind.plan!(session, action as never, prepared)).toEqual({ ok: false, reason: expect.stringMatching(/^SEC-99 could not be read/) });
  });

  it('refuses a ticket key that is not one', async () => {
    const session = await openVeracode(flaws('101'));
    expect(importKind.plan!(session, { type: 'new-add', ids: [rowId(session, '101')], key: 'not a key', mode: 'comment' } as never))
      .toEqual({ ok: false, reason: expect.stringMatching(/ticket key/i) });
  });
});
