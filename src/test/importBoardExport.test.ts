import ExcelJS from 'exceljs';
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
import type { JiraIssue, JiraSearchResult } from '../jira/IJiraClient';
import type { Session } from '../sessions/sessionTypes';
import { XLSX_FILLS } from '../utils/securityOverviewXlsx';
import { MockJiraClient } from './mocks/MockJiraClient';

// The import board's search over the tickets the review matched, the overview export built from the
// reading the board shows, and the finished state once no tab has work left.

interface Ticket {
  labels: string[];
  summary?: string;
  updated: string;
  due?: string;
  fixVersions?: string[];
  /** The assignee's display name; unassigned when absent. */
  assignee?: string;
  /** Custom field values by field id. */
  fields?: Record<string, unknown>;
}

class FakeJira extends MockJiraClient {
  tickets: Record<string, Ticket> = {};
  /** Every request the board made to Jira, in order. */
  requests: string[] = [];
  /** The extra field ids each search asked for. */
  extraRequested: string[][] = [];

  private issue(key: string): JiraIssue {
    const t = this.tickets[key];
    return {
      id: key, key,
      fields: {
        labels: t.labels, summary: t.summary ?? `Ticket ${key}`, status: { name: 'Open' }, resolution: null,
        created: '2026-01-01T09:00:00.000+0000', duedate: t.due ?? null, updated: t.updated, issuetype: { name: 'Bug' },
        fixVersions: (t.fixVersions ?? []).map(name => ({ name })), description: '',
        assignee: t.assignee === undefined ? null : { displayName: t.assignee }, ...t.fields,
      },
    } as unknown as JiraIssue;
  }

  override async getFields(): Promise<never> {
    return [{ id: 'customfield_1', name: 'Squad', schema: { type: 'string' } }] as never;
  }

  override async searchJql(jql: string, _max?: number, _startAt?: number, extra?: string[]): Promise<JiraSearchResult> {
    this.requests.push(`search ${jql}`);
    this.extraRequested.push(extra ?? []);
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
    this.requests.push(`issue ${key}`);
    if (!this.tickets[key]) throw Object.assign(new Error('Jira answered 404'), { status: 404 });
    return this.issue(key);
  }

  override async getProject(): Promise<never> {
    this.requests.push('project');
    return { key: 'PROJ', name: 'Project', issueTypes: [{ name: 'Bug', subtask: false }], versions: [{ name: '1.0', releaseDate: '2026-12-01', released: false }] } as never;
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
/** What `ticketSidekick.jira.securityReportFields` holds in the test window. */
let reportFields: string[] = [];
// Today is 15 November 2026 (local time), before the 1.0 release on 1 December.
const clock = new Date(2026, 10, 15, 12, 0, 0).getTime();

beforeEach(async () => {
  dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ts-import-export-'));
  jira = new FakeJira();
  reportFields = [];
  const veracode = createVeracodeDescriptor({
    filter: () => ({ minSeverity: 3, includeStatuses: ['New', 'Open', 'Reopened'], maxReportBytes: 20 * 1024 * 1024 }),
    slaDays: () => undefined,
  }, { reviewColumns: [] });
  const waltz = createWaltzDescriptor({
    filter: () => ({ minVulnRating: 'High', includeRemediationActions: ['', 'Remediate'], maxReportBytes: 20 * 1024 * 1024 }),
    minVulnRating: () => 'High',
    workspaceRoot: () => dir,
  }, { reviewColumns: [] });
  deps = importJiraDeps({
    getJira: async () => ({ configured: true, client: jira, config: { baseUrl: 'https://jira.example.com', securityReportFields: reportFields } }) as never,
    workspaceFolder: () => dir,
    descriptors: { veracode, waltz, email: createEmailDescriptor({ deleteEmlAfterImport: () => false, maxBatchBytes: () => 1024 * 1024 }) },
    now: () => clock,
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
    recipe: validated.recipe, derived: await importKind.read(validated.recipe, deps), working: importKind.initialWorking(validated.recipe), conflicts: [],
  };
}

function act(session: ImportSession, action: unknown): ImportSession {
  const reduced = importKind.reduce(session, action as never);
  if (!reduced.ok) throw new Error(reduced.reason);
  return { ...session, working: reduced.working };
}

interface SearchView {
  query: string;
  total: number;
  results: Array<{ key: string; summary: string; status: string | null; url: string | null }>;
  message?: string;
}
interface Extras { search: SearchView | null; finishedMessage: string }

const extras = (v: ImportView) => v.ext['search-export'] as Extras;
const veracodeTicket = (id: string, more: Partial<Ticket> = {}): Ticket => ({ labels: ['veracode', `veracode-issue-${id}`], updated: 't1', ...more });

/** A small CSV reader: cells split on the delimiter, with quoted cells. */
function readCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') quoted = false; else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length > 0) { row.push(cell); rows.push(row); }
  return rows;
}

/** Two matched tickets, one overdue and one due before its release, and one finding with no ticket yet. */
function twoMatchedTickets(): void {
  jira.tickets = {
    'PROJ-1': veracodeTicket('101', { summary: 'Hard-coded password in Login.java', due: '2026-11-01' }),
    'PROJ-2': veracodeTicket('102', { summary: '=1+2', due: '2026-11-20', fixVersions: ['1.0'] }),
  };
}

describe('searching the matched tickets', () => {
  it('lists the matched tickets whose summary holds the word, with status and link, without asking Jira', async () => {
    twoMatchedTickets();
    const session = await openVeracode([{ id: '101', file: 'Login.java' }, { id: '102', file: 'Report.java' }, { id: '103', file: 'New.java' }]);
    const before = jira.requests.length;

    const searched = act(session, { type: 'search', query: 'PASSWORD' });
    const v = importKind.view(searched);

    expect(extras(v).search).toEqual({
      query: 'PASSWORD', total: 1,
      results: [{ key: 'PROJ-1', summary: 'Hard-coded password in Login.java', status: 'Open', url: 'https://jira.example.com/browse/PROJ-1' }],
    });
    expect(jira.requests.length).toBe(before);

    // An empty search clears the results.
    const cleared = act(searched, { type: 'search', query: '  ' });
    expect(extras(importKind.view(cleared)).search).toBeNull();
  });

  it('says so when no matched ticket has the word in its summary', async () => {
    twoMatchedTickets();
    const session = await openVeracode([{ id: '101', file: 'Login.java' }, { id: '102', file: 'Report.java' }]);
    const v = importKind.view(act(session, { type: 'search', query: 'netty' }));
    expect(extras(v).search).toMatchObject({ query: 'netty', total: 0, results: [] });
    expect(extras(v).search!.message).toMatch(/no open ticket/i);
  });
});

describe('exporting the overview', () => {
  it('saves a CSV with the due-date columns, the overdue and due-before-release flags, and formula cells shown as text', async () => {
    twoMatchedTickets();
    const session = await openVeracode([{ id: '101', file: 'Login.java' }, { id: '102', file: 'Report.java' }, { id: '103', file: 'New.java' }]);
    const before = jira.requests.length;

    const file = await importKind.exportFile!(session, 'csv', deps);

    expect(jira.requests.length).toBe(before);
    expect(file).toMatchObject({ fileName: 'security-overview-veracode-2026-11-15.csv', filterName: 'CSV', extension: 'csv' });
    const rows = readCsv(new TextDecoder().decode(file.bytes).replace(/^﻿/, ''));
    const header = rows[0];
    for (const title of ['Due Date', 'Policy date', 'Planned date', 'Attestation date', 'Flag', 'Report match']) expect(header).toContain(title);
    const col = (name: string) => header.indexOf(name);
    const byTicket = (key: string) => rows.find(r => r[col('Ticket')] === key)!;

    expect(byTicket('PROJ-1')[col('Due Date')]).toBe('2026-11-01');
    expect(byTicket('PROJ-1')[col('Flag')]).toBe('overdue');
    expect(byTicket('PROJ-2')[col('Fix Version')]).toBe('1.0');
    expect(byTicket('PROJ-2')[col('Release Date')]).toBe('2026-12-01');
    expect(byTicket('PROJ-2')[col('Flag')]).toBe('due before release');
    expect(byTicket('PROJ-2')[col('Summary')]).toBe("'=1+2");
    // The finding with no ticket yet is listed from the report.
    const untracked = rows.find(r => r[col('Issue ID')] === '103')!;
    expect(untracked[col('Ticket')]).toBe('');
    expect(untracked[col('Report match')]).toBe('in report, no ticket');
  });

  it('separates the CSV columns with the configured overview separator', async () => {
    twoMatchedTickets();
    const session = await openVeracode([{ id: '101', file: 'Login.java' }]);

    const file = await importKind.exportFile!(session, 'csv', { ...deps, csvDelimiter: () => ';' });

    const headerLine = new TextDecoder().decode(file.bytes).replace(/^﻿/, '').split(/\r?\n/)[0];
    expect(headerLine.split(';')).toContain('Due Date');
    expect(headerLine).not.toContain(',Due Date');
  });

  it('saves an Excel workbook with date cells and the flag fills', async () => {
    twoMatchedTickets();
    const session = await openVeracode([{ id: '101', file: 'Login.java' }, { id: '102', file: 'Report.java' }]);

    const file = await importKind.exportFile!(session, 'xlsx', deps);

    expect(file).toMatchObject({ fileName: 'security-overview-veracode-2026-11-15.xlsx', filterName: 'Excel', extension: 'xlsx' });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.from(file.bytes) as never);
    const sheet = workbook.getWorksheet('Security overview')!;
    const header = sheet.getRow(1).values as unknown[];
    const col = (name: string) => header.indexOf(name);
    const rowOf = (key: string) => {
      for (let r = 2; r <= sheet.rowCount; r++) if (sheet.getRow(r).getCell(col('Ticket')).value === key) return sheet.getRow(r);
      throw new Error(key);
    };
    const due = rowOf('PROJ-1').getCell(col('Due Date')).value;
    expect(due).toBeInstanceOf(Date);
    expect((due as Date).toISOString().slice(0, 10)).toBe('2026-11-01');
    const fill = (key: string) => (rowOf(key).getCell(col('Ticket')).fill as ExcelJS.FillPattern | undefined)?.fgColor?.argb;
    expect(fill('PROJ-1')).toBe(XLSX_FILLS.overdue);
    expect(fill('PROJ-2')).toBe(XLSX_FILLS['due-before-release']);
  });

  it('refuses the export with the reason when the tickets could not be read with the review', async () => {
    twoMatchedTickets();
    const session = await openVeracode([{ id: '101', file: 'Login.java' }]);
    session.derived.data.export.ticketsProblem = 'Jira answered 503 while reading the tickets.';
    await expect(importKind.exportFile!(session, 'csv', deps)).rejects.toThrow('Jira answered 503 while reading the tickets.');
  });
});

describe('a finished import', () => {
  it('says there is nothing left to do, offers Close, and still saves the export', async () => {
    jira.tickets = { 'PROJ-1': veracodeTicket('301', { summary: 'Hard-coded password in A.java', due: '2026-11-01' }) };
    const session = await openVeracode([{ id: '301', file: 'A.java' }]);

    const v = importKind.view(session);

    expect(v.finished).toBe(true);
    expect(extras(v).finishedMessage).toMatch(/nothing left to do/i);
    expect(extras(v).finishedMessage).toMatch(/close/i);
    const file = await importKind.exportFile!(session, 'csv', deps);
    expect(new TextDecoder().decode(file.bytes)).toContain('PROJ-1');
  });
});

describe('exporting the overview with an assignee and extra columns', () => {
  const ownedTickets = (): void => {
    jira.tickets = {
      'PROJ-1': veracodeTicket('101', { summary: 'Hard-coded password in Login.java', assignee: 'Dana', fields: { customfield_1: 'Team 2' } }),
      'PROJ-2': veracodeTicket('102', { summary: 'Another finding', fields: { customfield_1: 'Team 10' } }),
    };
  };
  const exported = async () => {
    const session = await openVeracode([{ id: '101', file: 'Login.java' }, { id: '102', file: 'Report.java' }, { id: '103', file: 'New.java' }]);
    const rows = readCsv(new TextDecoder().decode((await importKind.exportFile!(session, 'csv', deps)).bytes).replace(/^﻿/, ''));
    const col = (name: string) => rows[0].indexOf(name);
    return { rows, col, byTicket: (key: string) => rows.find(r => r[col('Ticket')] === key)! };
  };

  it('writes Assignee and each configured column, "Unassigned" for an unassigned ticket and nothing for a finding with no ticket', async () => {
    reportFields = ['customfield_1', 'assignee', 'customfield_404'];
    ownedTickets();
    const { rows, col, byTicket } = await exported();

    expect(rows[0].slice(-2)).toEqual(['Assignee', 'Squad']);
    expect(byTicket('PROJ-1')[col('Assignee')]).toBe('Dana');
    expect(byTicket('PROJ-1')[col('Squad')]).toBe('Team 2');
    expect(byTicket('PROJ-2')[col('Assignee')]).toBe('Unassigned');
    expect(byTicket('PROJ-2')[col('Squad')]).toBe('Team 10');
    const untracked = rows.find(r => r[col('Issue ID')] === '103')!;
    expect([untracked[col('Assignee')], untracked[col('Squad')]]).toEqual(['', '']);
  });

  it('asks Jira for the configured fields with the search that reads the matched tickets', async () => {
    reportFields = ['customfield_1'];
    ownedTickets();
    await exported();
    expect(jira.extraRequested.some(extra => extra.includes('duedate') && extra.includes('customfield_1'))).toBe(true);
  });

  it('writes Assignee alone, and asks for no extra field, when the setting is empty', async () => {
    ownedTickets();
    const { rows, col, byTicket } = await exported();
    expect(rows[0].at(-1)).toBe('Assignee');
    expect(rows[0]).not.toContain('Squad');
    expect(byTicket('PROJ-1')[col('Assignee')]).toBe('Dana');
    expect(jira.extraRequested.flat()).not.toContain('customfield_1');
  });
});
