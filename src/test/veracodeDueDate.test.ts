import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const sla = vi.hoisted(() => ({ value: undefined as unknown }));

vi.mock('vscode', () => ({
  workspace: {
    workspaceFolders: undefined,
    getConfiguration: vi.fn(() => ({ get: (key: string) => (key === 'veracode.slaDays' ? sla.value : undefined) })),
  },
  window: {
    showInputBox: vi.fn(),
    showOpenDialog: vi.fn(),
    createOutputChannel: vi.fn(() => ({ appendLine: vi.fn() })),
  },
  Uri: { file: (p: string) => ({ fsPath: p }) },
  MarkdownString: class { constructor(public value = '') {} isTrusted?: unknown; },
}));

vi.mock('../templates/TemplateService', () => ({
  TemplateService: vi.fn().mockImplementation(function () { return ({ loadTemplates: vi.fn() }); }),
}));

vi.mock('../services/WorkflowService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/WorkflowService')>()),
  loadWorkflowCache: vi.fn(),
}));

import { handleVeracodeAwaitIssueType, buildVeracodeTemplateSession, handleVeracodeReviewReply } from '../participant/jira/veracodeHandler';
import type { AwaitIssueTypeResume, VeracodeReviewSession } from '../participant/sessionState';
import { MockJiraClient } from './mocks/MockJiraClient';
import { TicketService } from '../services/TicketService';
import { JiraApiError } from '../utils/apiError';
import type { VeracodeFlaw } from '../utils/veracodeReport';
import { mockStream, makeMockWs, FakeTicket, statefulJira, searchFromStore, streamText, diagLines } from './helpers/reportImportHarness';

const SHIPPED = { 'Very High': 14, High: 28, Medium: 0, Low: 0, 'Very Low': 0, Informational: 0 };

// A different file and CWE per flaw, so each stays its own row under the automatic fold.
let seq = 0;
function flaw(overrides: Partial<VeracodeFlaw> = {}): VeracodeFlaw {
  const n = ++seq;
  return {
    issueId: String(900 + n), severity: 4, categoryName: 'SQL Injection', cweId: String(1000 + n), cweName: null,
    description: 'Untrusted input reaches a query.', recommendation: null, module: 'app.jar',
    sourceFile: `File${n}.java`, sourceFilePath: 'src/main/java/', line: 40 + n, scope: null, functionPrototype: null,
    remediationStatus: 'New', firstFoundDate: null,
    ...overrides,
  };
}

const refusal = () => new JiraApiError(
  'Jira API error 400', 400, 'https://jira.example.com/rest/api/2/issue',
  JSON.stringify({ errorMessages: [], errors: { duedate: "Field 'duedate' cannot be set. It is not on the appropriate screen, or unknown." } }),
);

let client: MockJiraClient;
let ticketService: TicketService;
let tickets: Record<string, FakeTicket>;

beforeEach(() => {
  seq = 0;
  sla.value = SHIPPED;
  client = new MockJiraClient();
  ticketService = new TicketService(client);
  tickets = {};
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-23T12:00:00'));
});

afterEach(() => {
  vi.useRealTimers();
});

let screen = '';

async function importVeracode(report: VeracodeFlaw[]) {
  statefulJira(client, tickets);
  searchFromStore(ticketService, tickets);
  const templateSession = await buildVeracodeTemplateSession(report, 'report.xml', 'PROJ', client);
  const ws = makeMockWs();
  const resume: Extract<AwaitIssueTypeResume, { kind: 'reportImport' }> = {
    kind: 'reportImport', descriptorKind: 'veracode', pickedTemplateName: null, session: templateSession,
  };
  const stream = mockStream();
  await handleVeracodeAwaitIssueType(resume, 'Bug', client, ticketService, stream as never, ws as never);
  screen = streamText(stream);
  return ws;
}

async function reply(text: string, ws: ReturnType<typeof makeMockWs>) {
  const stream = mockStream();
  const session = ws.store['jira.session.veracodeReview'] as VeracodeReviewSession;
  await handleVeracodeReviewReply(text, session, ticketService, stream as never, ws as never);
  return streamText(stream);
}

const created = (i = 0) => client.createIssueCalls[i].additionalFields as Record<string, unknown>;

describe('the Due Date of a new Veracode ticket', () => {
  it('AE1: is the first-found date plus the days for the severity, even when already past, and the description shows both dates', async () => {
    sla.value = { 'Very High': 30 };
    const ws = await importVeracode([flaw({ severity: 5, firstFoundDate: '2026-09-01' })]);
    await reply('create tickets', ws);
    expect(created().duedate).toBe('2026-10-01');
    expect(String(created().description)).toContain('2026-09-01');
    expect(String(created().description)).toContain('2026-10-01');
  });

  it('AE14: follows the shipped table (High 28 days)', async () => {
    const ws = await importVeracode([flaw({ severity: 4, firstFoundDate: '2026-10-01' })]);
    await reply('create tickets', ws);
    expect(created().duedate).toBe('2026-10-29');
  });

  it('AE2: is not sent at all for a severity at 0', async () => {
    const ws = await importVeracode([flaw({ severity: 2, firstFoundDate: '2026-09-01' })]);
    await reply('create tickets', ws);
    expect(created()).not.toHaveProperty('duedate');
  });

  it('counts a flaw with no first-found date from the import date', async () => {
    sla.value = { High: 60 };
    const ws = await importVeracode([flaw({ severity: 4, firstFoundDate: null })]);
    await reply('create tickets', ws);
    expect(created().duedate).toBe('2026-12-22');
    expect(String(created().description)).toContain('2026-12-22');
  });

  it('is not sent when the setting is absent', async () => {
    sla.value = undefined;
    const ws = await importVeracode([flaw({ severity: 5, firstFoundDate: '2026-09-01' })]);
    await reply('create tickets', ws);
    expect(created()).not.toHaveProperty('duedate');
  });

  it('AE5: a fold takes the earliest due date of its flaws, each with its own severity', async () => {
    sla.value = { 'Very High': 14, High: 60, Low: 0 };
    // One file and one CWE, so the three flaws fold into one ticket.
    const shared = { sourceFile: 'Shared.java', cweId: '89' };
    const ws = await importVeracode([
      flaw({ ...shared, severity: 4, firstFoundDate: '2026-10-02' }),
      flaw({ ...shared, severity: 5, firstFoundDate: '2026-11-01' }),
      flaw({ ...shared, severity: 2, firstFoundDate: '2026-09-01' }),
    ]);
    await reply('create tickets', ws);
    expect(client.createIssueCalls).toHaveLength(1);
    expect(created().duedate).toBe('2026-11-15');
  });

  it('a template\'s own duedate is overridden when the policy has a date, and kept when it has none', async () => {
    for (const [severity, expected] of [[5, '2026-10-15'], [2, '2027-06-01']] as const) {
      seq = 0;
      client = new MockJiraClient();
      ticketService = new TicketService(client);
      tickets = {};
      const ws = await importVeracode([flaw({ severity, firstFoundDate: '2026-10-01' })]);
      const stored = ws.store['jira.session.veracodeReview'] as VeracodeReviewSession;
      ws.store['jira.session.veracodeReview'] = { ...stored, additionalFields: { duedate: '2027-06-01' } };
      await reply('create tickets', ws);
      expect(created().duedate).toBe(expected);
    }
  });

  it('AE6: a project without the field still gets the ticket, with a warning and the dates in the description', async () => {
    const ws = await importVeracode([flaw({ severity: 5, firstFoundDate: '2026-10-01' })]);
    const createIssue = client.createIssue;
    client.createIssue = async (projectKey, summary, issueType, fields) => {
      if (fields && 'duedate' in fields) { client.createIssueCalls.push({ projectKey, summary, issueType, additionalFields: fields }); throw refusal(); }
      return createIssue(projectKey, summary, issueType, fields);
    };
    const text = await reply('create tickets', ws);
    expect(client.createIssueCalls).toHaveLength(2);
    expect(client.createIssueCalls[1].additionalFields).not.toHaveProperty('duedate');
    expect(String(client.createIssueCalls[1].additionalFields?.description)).toContain('2026-10-15');
    expect(text).toContain('✓');
    expect(text).toMatch(/Due Date/i);
    expect(diagLines().some(l => l.includes('duedate') && l.includes('refused'))).toBe(true);
  });
});

describe('the Due Date written by add … as rewrite and as comment', () => {
  const existing = (extra: Partial<FakeTicket> = {}) => ({
    'PROJ-5': { labels: ['hand-made'], summary: 'Hand made', created: '2026-10-01T09:00:00.000+0000', ...extra } as FakeTicket,
  });

  it('AE15: moves an existing Due Date earlier when the joining flaw is due sooner', async () => {
    sla.value = { 'Very High': 30 };
    tickets = existing({ duedate: '2026-12-01' });
    const ws = await importVeracode([flaw({ severity: 5, firstFoundDate: '2026-10-02' })]);
    await reply('add 1 to PROJ-5 as rewrite', ws);
    expect(client.updateIssueCalls).toHaveLength(1);
    expect(client.updateIssueCalls[0].fields.duedate).toBe('2026-11-01');
  });

  it('AE15: leaves an existing Due Date alone when the joining flaw is due later', async () => {
    sla.value = { High: 60 };
    tickets = existing({ duedate: '2026-12-01' });
    const ws = await importVeracode([flaw({ severity: 4, firstFoundDate: '2026-11-16' })]);
    await reply('add 1 to PROJ-5 as rewrite', ws);
    expect(client.updateIssueCalls).toHaveLength(1);
    expect(client.updateIssueCalls[0].fields).not.toHaveProperty('duedate');
    expect(tickets['PROJ-5'].duedate).toBe('2026-12-01');
  });

  it('sets the policy date on a ticket that has none', async () => {
    sla.value = { 'Very High': 30 };
    tickets = existing();
    const ws = await importVeracode([flaw({ severity: 5, firstFoundDate: '2026-10-02' })]);
    await reply('add 1 to PROJ-5 as rewrite', ws);
    expect(client.updateIssueCalls[0].fields.duedate).toBe('2026-11-01');
  });

  it('counts a flaw with no first-found date from the existing ticket\'s creation date, not from today', async () => {
    sla.value = { High: 60 };
    tickets = existing();
    const ws = await importVeracode([flaw({ severity: 4, firstFoundDate: null })]);
    await reply('add 1 to PROJ-5 as rewrite', ws);
    expect(client.updateIssueCalls[0].fields.duedate).toBe('2026-11-30');
  });

  it('keeps the rewrite when Jira refuses the Due Date, and says so', async () => {
    sla.value = { 'Very High': 30 };
    tickets = existing();
    const ws = await importVeracode([flaw({ severity: 5, firstFoundDate: '2026-10-02' })]);
    const update = client.updateIssue;
    client.updateIssue = async (key, fields) => {
      if ('duedate' in fields) { client.updateIssueCalls.push({ issueKey: key, fields }); throw refusal(); }
      return update(key, fields);
    };
    const text = await reply('add 1 to PROJ-5 as rewrite', ws);
    expect(client.updateIssueCalls).toHaveLength(2);
    expect(client.updateIssueCalls[1].fields).not.toHaveProperty('duedate');
    expect(text).toMatch(/Due Date/i);
  });

  it('AE10: as comment writes no Due Date and the comment lists the added flaw\'s dates', async () => {
    sla.value = { 'Very High': 30 };
    tickets = existing({ duedate: '2026-12-01' });
    const ws = await importVeracode([flaw({ severity: 5, firstFoundDate: '2026-10-02' })]);
    await reply('add 1 to PROJ-5 as comment', ws);
    expect(client.updateIssueCalls.every(c => !('duedate' in c.fields))).toBe(true);
    expect(client.addCommentCalls[0].body).toContain('2026-10-02');
    expect(client.addCommentCalls[0].body).toContain('2026-11-01');
  });
});

describe('the Due Date of an Already-ticketed rewrite and of a new ticket', () => {
  it('a rewrite of a ticket with no Due Date sets the earliest date over its flaws, counting an undated flaw from the ticket\'s creation date', async () => {
    sla.value = { High: 60 };
    tickets = { 'PROJ-1': { labels: ['veracode', 'veracode-issue-901'], created: '2026-10-01T09:00:00.000+0000' } };
    const ws = await importVeracode([flaw({ issueId: '901', severity: 4, firstFoundDate: null })]);
    await reply('A1 rewrite', ws);
    await reply('apply', ws);
    expect(client.updateIssueCalls).toHaveLength(1);
    expect(client.updateIssueCalls[0].fields.duedate).toBe('2026-11-30');
  });

  it('a rewrite of a ticket that already has a Due Date, with no new flaw, sends none', async () => {
    sla.value = { High: 60 };
    tickets = { 'PROJ-1': { labels: ['veracode', 'veracode-issue-901'], duedate: '2026-12-31' } };
    const ws = await importVeracode([flaw({ issueId: '901', severity: 4, firstFoundDate: '2026-10-02' })]);
    await reply('A1 rewrite', ws);
    await reply('apply', ws);
    expect(client.updateIssueCalls).toHaveLength(1);
    expect(client.updateIssueCalls[0].fields).not.toHaveProperty('duedate');
    expect(tickets['PROJ-1'].duedate).toBe('2026-12-31');
  });

  it('a new finding on the ticket can move its Due Date earlier, never later', async () => {
    sla.value = { 'Very High': 14, High: 60 };
    tickets = { 'PROJ-1': { labels: ['veracode', 'veracode-issue-901'], duedate: '2026-12-01' } };
    // One file and one CWE, so 901 (recorded on the ticket) and 902 (new) are one group.
    const shared = { sourceFile: 'Shared.java', cweId: '89' };
    const ws = await importVeracode([
      flaw({ ...shared, issueId: '901', severity: 4, firstFoundDate: '2026-10-02' }),
      flaw({ ...shared, issueId: '902', severity: 5, firstFoundDate: '2026-10-20' }),
    ]);
    await reply('apply', ws);
    expect(client.updateIssueCalls).toHaveLength(1);
    expect(client.updateIssueCalls[0].fields.duedate).toBe('2026-11-03');
  });

  it('a new ticket for a resolved one carries the Due Date counted from the import date', async () => {
    sla.value = { High: 60 };
    tickets = { 'PROJ-1': { labels: ['veracode', 'veracode-issue-901'], resolution: { name: 'Done' } } };
    const shared = { sourceFile: 'Shared.java', cweId: '89' };
    const ws = await importVeracode([
      flaw({ ...shared, issueId: '901', severity: 4, firstFoundDate: '2026-10-02' }),
      flaw({ ...shared, issueId: '902', severity: 4, firstFoundDate: null }),
    ]);
    await reply('apply', ws);
    expect(client.createIssueCalls).toHaveLength(1);
    // The new ticket covers the whole group: 901 due 2026-12-01 (first found 2026-10-02 + 60), 902 counted from today 2026-10-23 (+ 60 = 2026-12-22).
    expect(created().duedate).toBe('2026-12-01');
  });

  it('the result line says where the date came from and does not claim to replace a hand edit', async () => {
    sla.value = { High: 60 };
    tickets = { 'PROJ-1': { labels: ['veracode', 'veracode-issue-901'] } };
    const ws = await importVeracode([flaw({ issueId: '901', severity: 4, firstFoundDate: '2026-10-02' })]);
    await reply('A1 rewrite', ws);
    const text = await reply('apply', ws);
    expect(text).toContain('Due Date set to 2026-12-01');
    expect(text).toContain('SLA');
    expect(text).not.toContain('edited by hand');
  });
});

describe('backfilling a Due Date on the Already ticketed screen', () => {
  const session = (ws: ReturnType<typeof makeMockWs>) => ws.store['jira.session.veracodeReview'] as VeracodeReviewSession;
  const onTicket = (extra: Partial<FakeTicket> = {}, ids = ['901']) => ({
    labels: ['veracode', ...ids.map(id => `veracode-issue-${id}`)], created: '2026-10-01T09:00:00.000+0000', ...extra,
  }) as FakeTicket;

  it('AE7: an open ticket with an empty Due Date is a change, shown as none to the policy date, and defaults to rewrite', async () => {
    sla.value = { High: 60 };
    tickets = { 'PROJ-1': onTicket() };
    const ws = await importVeracode([flaw({ issueId: '901', severity: 4, firstFoundDate: '2026-10-02' })]);
    const row = session(ws).allRows[0];
    expect(row.change).toEqual({ kind: 'findings', newIds: [], dates: [{ date: 'due', from: null, to: '2026-12-01' }] });
    expect(row.action).toBe('rewrite');
    expect(row.allowedActions).toEqual(['rewrite', 'leave']);
    expect(screen).toContain('due none→2026-12-01');
  });

  it('applying the default sets the Due Date, and a rebuilt review then shows no change', async () => {
    sla.value = { High: 60 };
    tickets = { 'PROJ-1': onTicket() };
    const report = [flaw({ issueId: '901', severity: 4, firstFoundDate: '2026-10-02' })];
    const ws = await importVeracode(report);
    await reply('apply', ws);
    expect(client.updateIssueCalls).toHaveLength(1);
    expect(client.updateIssueCalls[0].fields.duedate).toBe('2026-12-01');
    expect(tickets['PROJ-1'].duedate).toBe('2026-12-01');

    const again = await importVeracode(report);
    expect(session(again).allRows[0].change).toBeNull();
    expect(session(again).allRows[0].action).toBe('leave');
  });

  it('AE13: an undated flaw is dated from the ticket\'s creation date, and the ticket then settles', async () => {
    sla.value = { High: 60 };
    tickets = { 'PROJ-1': onTicket() };
    const report = [flaw({ issueId: '901', severity: 4, firstFoundDate: null })];
    const ws = await importVeracode(report);
    expect(session(ws).allRows[0].change).toMatchObject({ dates: [{ date: 'due', from: null, to: '2026-11-30' }] });

    await reply('apply', ws);
    expect(tickets['PROJ-1'].duedate).toBe('2026-11-30');
    const again = await importVeracode(report);
    expect(session(again).allRows[0].change).toBeNull();
    expect(session(again).allRows[0].action).toBe('leave');
  });

  it('every row of a ticket shows the earliest due date, the one the rewrite writes', async () => {
    sla.value = { 'Very High': 14, High: 60 };
    tickets = { 'PROJ-1': onTicket({}, ['901', '902']) };
    const ws = await importVeracode([
      flaw({ issueId: '901', severity: 4, firstFoundDate: '2026-10-02', sourceFile: 'a.java', cweId: '79' }),
      flaw({ issueId: '902', severity: 5, firstFoundDate: '2026-10-02', sourceFile: 'b.java', cweId: '89' }),
    ]);
    expect(session(ws).allRows.map(r => r.change?.dates)).toEqual([
      [{ date: 'due', from: null, to: '2026-10-16' }],
      [{ date: 'due', from: null, to: '2026-10-16' }],
    ]);
    await reply('apply', ws);
    expect(client.updateIssueCalls.map(c => c.fields.duedate)).toEqual(['2026-10-16']);
  });

  it('AE8: a ticket that already has a Due Date is not a change, whatever the policy gives now', async () => {
    sla.value = { High: 14 };
    tickets = { 'PROJ-1': onTicket({ duedate: '2026-12-31' }) };
    const ws = await importVeracode([flaw({ issueId: '901', severity: 4, firstFoundDate: '2026-10-02' })]);
    expect(session(ws).allRows[0].change).toBeNull();
    expect(session(ws).allRows[0].action).toBe('leave');
  });

  it('AE9: a resolved ticket with no Due Date is not a change for dates', async () => {
    sla.value = { High: 60 };
    tickets = { 'PROJ-1': onTicket({ resolution: { name: 'Done' } }) };
    const ws = await importVeracode([flaw({ issueId: '901', severity: 4, firstFoundDate: '2026-10-02' })]);
    expect(session(ws).allRows[0].change).toBeNull();
    expect(session(ws).allRows[0].action).toBe('leave');
  });

  it('AE3: with every severity at 0 nothing is flagged for dates', async () => {
    sla.value = { 'Very High': 0, High: 0, Medium: 0, Low: 0, 'Very Low': 0, Informational: 0 };
    tickets = { 'PROJ-1': onTicket() };
    const ws = await importVeracode([flaw({ issueId: '901', severity: 4, firstFoundDate: '2026-10-02' })]);
    expect(session(ws).allRows[0].change).toBeNull();
  });

  it('a ticket whose flaws have no due date is never flagged', async () => {
    sla.value = { High: 60, Low: 0 };
    tickets = { 'PROJ-1': onTicket() };
    const ws = await importVeracode([flaw({ issueId: '901', severity: 2, firstFoundDate: '2026-10-02' })]);
    expect(session(ws).allRows[0].change).toBeNull();
  });

  it('rows pointing at one ticket share the rewrite default, and one apply rewrites the ticket once', async () => {
    sla.value = { High: 60, Low: 0 };
    tickets = { 'PROJ-1': onTicket({}, ['901', '902']) };
    const ws = await importVeracode([
      flaw({ issueId: '901', severity: 4, firstFoundDate: '2026-10-02' }),
      flaw({ issueId: '902', severity: 2, firstFoundDate: '2026-10-02' }),
    ]);
    expect(session(ws).allRows.map(r => r.action)).toEqual(['rewrite', 'rewrite']);
    await reply('apply', ws);
    expect(client.updateIssueCalls).toHaveLength(1);
    expect(client.updateIssueCalls[0].fields.duedate).toBe('2026-12-01');
  });

  it('a later change to the table does not reach a ticket that already has a Due Date', async () => {
    sla.value = { High: 60 };
    tickets = { 'PROJ-1': onTicket() };
    const report = [flaw({ issueId: '901', severity: 4, firstFoundDate: '2026-10-02' })];
    await reply('apply', await importVeracode(report));
    sla.value = { High: 14 };
    const again = await importVeracode(report);
    expect(session(again).allRows[0].change).toBeNull();
    expect(tickets['PROJ-1'].duedate).toBe('2026-12-01');
  });
});
