import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('vscode', () => ({
  workspace: {
    workspaceFolders: undefined,
    getConfiguration: vi.fn(() => ({ get: () => undefined })),
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

import { handleWaltzAwaitIssueType, handleWaltzReviewReply, buildWaltzTemplateSession } from '../participant/jira/waltzHandler';
import type { WaltzReviewSession } from '../participant/sessionState';
import { MockJiraClient } from './mocks/MockJiraClient';
import { TicketService } from '../services/TicketService';
import { JiraApiError } from '../utils/apiError';
import { sanitizeComponentLabel, type WaltzComponent } from '../utils/waltzReport';
import type { RemediationDates } from '../utils/waltzDates';
import { mockStream, makeMockWs, FakeTicket, statefulJira, searchFromStore, streamText, diagLines } from './helpers/reportImportHarness';

const comp = (nameVersion: string, dates: Partial<RemediationDates> = {}, status: string | null = null): WaltzComponent => ({
  nameVersion, maxVulnRating: 'High', remediationAction: 'Remediate', instancePaths: ['app.jar'],
  vulnerabilities: [{ cveId: 'CVE-2099-0001', cveSummary: null, overallSeverity: 'High', cvssV3Score: 7, fixedVersion: null }],
  remediation: { policyDate: null, plannedDate: null, planDeadline: null, planStatus: status, reportDate: '2026-10-22', ...dates },
});
const labelsFor = (c: WaltzComponent) => ['oss-dependency', sanitizeComponentLabel(c.nameVersion)];

const refusal = () => new JiraApiError(
  'Jira API error 400', 400, 'https://jira.example.com/rest/api/2/issue',
  JSON.stringify({ errorMessages: [], errors: { duedate: "Field 'duedate' cannot be set. It is not on the appropriate screen, or unknown." } }),
);

let client: MockJiraClient;
let ticketService: TicketService;
let tickets: Record<string, FakeTicket>;

beforeEach(() => {
  client = new MockJiraClient();
  ticketService = new TicketService(client);
  tickets = {};
});

async function importWaltz(report: WaltzComponent[]) {
  statefulJira(client, tickets);
  const getIssue = client.getIssue;
  client.getIssue = async key => {
    const issue = await getIssue(key);
    issue.fields.description = tickets[key]?.description as never;
    return issue;
  };
  searchFromStore(ticketService, tickets);
  const templateSession = await buildWaltzTemplateSession(report, 'r.xlsx', 'PROJ', client);
  const ws = makeMockWs();
  await handleWaltzAwaitIssueType({
    kind: 'reportImport', descriptorKind: 'waltz', pickedTemplateName: null, session: templateSession,
  }, 'Bug', client, ticketService, mockStream() as never, ws as never);
  return ws;
}

async function reply(text: string, ws: ReturnType<typeof makeMockWs>) {
  const stream = mockStream();
  const session = ws.store['jira.session.waltzReview'] as WaltzReviewSession;
  await handleWaltzReviewReply(text, session, ticketService, stream as never, ws as never);
  return streamText(stream);
}

describe('the Due Date of a new Waltz ticket', () => {
  it('AE1: is the planned date, and the description shows both dates', async () => {
    const ws = await importWaltz([comp('example-lib:1.2.3', { policyDate: '2026-11-30', plannedDate: '2026-12-15' })]);
    await reply('create tickets', ws);
    expect(client.createIssueCalls).toHaveLength(1);
    expect(client.createIssueCalls[0].additionalFields?.duedate).toBe('2026-12-15');
    const description = String(client.createIssueCalls[0].additionalFields?.description);
    expect(description).toContain('2026-11-30');
    expect(description).toContain('2026-12-15');
  });

  it('AE2: is the policy date when there is no planned date', async () => {
    const ws = await importWaltz([comp('example-lib:1.2.3', { policyDate: '2026-11-30' })]);
    await reply('create tickets', ws);
    expect(client.createIssueCalls[0].additionalFields?.duedate).toBe('2026-11-30');
  });

  it('AE4: is not sent at all when the component has no dates', async () => {
    const ws = await importWaltz([comp('example-lib:1.2.3')]);
    await reply('create tickets', ws);
    expect(client.createIssueCalls[0].additionalFields).not.toHaveProperty('duedate');
    expect(String(client.createIssueCalls[0].additionalFields?.description)).toContain('|example-lib:1.2.3|High|Remediate|1|1|n/a|n/a|n/a|n/a|');
  });

  it('a template\'s own duedate is overridden by the report\'s date, and kept when the report has none', async () => {
    for (const [component, expected] of [[comp('example-lib:1.2.3', { policyDate: '2026-11-30' }), '2026-11-30'], [comp('example-other:2.0.0'), '2027-06-01']] as const) {
      client = new MockJiraClient();
      ticketService = new TicketService(client);
      tickets = {};
      client.createIssueCalls.length = 0;
      const ws = await importWaltz([component]);
      const stored = ws.store['jira.session.waltzReview'] as WaltzReviewSession;
      ws.store['jira.session.waltzReview'] = { ...stored, additionalFields: { duedate: '2027-06-01' } };
      await reply('create tickets', ws);
      expect(client.createIssueCalls[0].additionalFields?.duedate).toBe(expected);
    }
  });

  it('AE5: a folded ticket takes the earliest member date and lists every member', async () => {
    const ws = await importWaltz([
      comp('example-a:1.0.0', { plannedDate: '2026-12-15' }),
      comp('example-b:2.0.0', { policyDate: '2026-11-30' }),
      comp('example-c:3.0.0'),
    ]);
    await reply('merge 1 2 3', ws);
    await reply('create tickets', ws);
    expect(client.createIssueCalls).toHaveLength(1);
    expect(client.createIssueCalls[0].additionalFields?.duedate).toBe('2026-11-30');
    const description = String(client.createIssueCalls[0].additionalFields?.description);
    for (const name of ['example-a:1.0.0', 'example-b:2.0.0', 'example-c:3.0.0']) expect(description).toContain(name);
  });

  it('AE6: a project without the field still gets the ticket, with a warning and the dates in the description', async () => {
    const ws = await importWaltz([comp('example-lib:1.2.3', { policyDate: '2026-11-30' })]);
    const created = client.createIssue;
    client.createIssue = async (projectKey, summary, issueType, fields) => {
      if (fields && 'duedate' in fields) { client.createIssueCalls.push({ projectKey, summary, issueType, additionalFields: fields }); throw refusal(); }
      return created(projectKey, summary, issueType, fields);
    };
    const text = await reply('create tickets', ws);
    expect(client.createIssueCalls).toHaveLength(2);
    expect(client.createIssueCalls[1].additionalFields).not.toHaveProperty('duedate');
    expect(String(client.createIssueCalls[1].additionalFields?.description)).toContain('2026-11-30');
    expect(text).toContain('✓');
    expect(text).toMatch(/Due Date/i);
    expect(text).toMatch(/description/i);
    expect(diagLines().some(l => l.includes('duedate') && l.includes('refused'))).toBe(true);
  });
});

describe('the Due Date written by add … as rewrite', () => {
  const existing = () => ({ 'PROJ-5': { labels: ['oss-rating-medium'], summary: 'Hand made' } as FakeTicket });

  it('sets the Due Date from the combined group in the same write', async () => {
    tickets = existing();
    const ws = await importWaltz([comp('example-a:1.0.0', { plannedDate: '2026-12-15' })]);
    await reply('add 1 to PROJ-5 as rewrite', ws);
    expect(client.updateIssueCalls).toHaveLength(1);
    expect(client.updateIssueCalls[0].fields.duedate).toBe('2026-12-15');
    expect(client.updateIssueCalls[0].fields.summary).toBe('[OSS] example-a:1.0.0 — High');
  });

  it('sends no duedate for a group without a date, leaving the ticket\'s own', async () => {
    tickets = existing();
    const ws = await importWaltz([comp('example-a:1.0.0')]);
    await reply('add 1 to PROJ-5 as rewrite', ws);
    expect(client.updateIssueCalls[0].fields).not.toHaveProperty('duedate');
  });

  it('keeps the rewrite when Jira refuses the Due Date, and says so', async () => {
    tickets = existing();
    const ws = await importWaltz([comp('example-a:1.0.0', { policyDate: '2026-11-30' })]);
    const update = client.updateIssue;
    client.updateIssue = async (key, fields) => {
      if ('duedate' in fields) { client.updateIssueCalls.push({ issueKey: key, fields }); throw refusal(); }
      return update(key, fields);
    };
    const text = await reply('add 1 to PROJ-5 as rewrite', ws);
    expect(client.updateIssueCalls).toHaveLength(2);
    expect(client.updateIssueCalls[1].fields).not.toHaveProperty('duedate');
    expect(client.updateIssueCalls[1].fields.summary).toBe('[OSS] example-a:1.0.0 — High');
    expect(text).toMatch(/Due Date/i);
  });

  it('as comment adds the dates to the comment and writes no Due Date', async () => {
    tickets = existing();
    const ws = await importWaltz([comp('example-a:1.0.0', { policyDate: '2026-11-30' })]);
    await reply('add 1 to PROJ-5 as comment', ws);
    expect(client.updateIssueCalls.every(c => !('duedate' in c.fields))).toBe(true);
    expect(client.addCommentCalls[0].body).toContain('2026-11-30');
  });
});
