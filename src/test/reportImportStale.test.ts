import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
  TemplateService: vi.fn().mockImplementation(() => ({
    loadTemplates: vi.fn(),
  })),
}));

// U6: buildStaleTicketGroups (cleanupHandler.ts, called transitively via continueAfterImportIssueType)
// reads the cached workflow graph — only the cache read is mocked, so each stale test controls its
// own graph while path-finding and the reachable-status lookup run for real against it.
vi.mock('../services/WorkflowService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/WorkflowService')>()),
  loadWorkflowCache: vi.fn(),
}));

import * as vscode from 'vscode';
import { continueAfterImportIssueType, handleImportReviewReply, continueStaleClose, type ReportImportDescriptor } from '../participant/jira/reportImportHandler';
import { type ReviewSession } from '../participant/sessionState';
import { loadWorkflowCache } from '../services/WorkflowService';
import { MockJiraClient } from './mocks/MockJiraClient';
import { TicketService } from '../services/TicketService';
import { TemplateService } from '../templates/TemplateService';
import { TestItem, TestRow, descriptor, mockStream, markdownText, makeMockWs, makeSession } from './helpers/reportImportHarness';

// Stale-ticket review section + close (U6, reworked by the stale-ticket target pick plan),
// exercised end to end through the generic test descriptor — the shared code path both Veracode's
// and Waltz's real descriptors reuse.
describe('Stale-ticket review + close with a picked target', () => {
  let client: MockJiraClient;
  let ticketService: TicketService;

  const CLOSE_KEY = 'jira.session.staleResolution';
  const bugGraph = {
    Open: [{ id: '11', name: 'Verify', to: 'Verification' }, { id: '12', name: 'Close', to: 'Done' }],
    Verification: [{ id: '21', name: 'Accept', to: 'Done' }],
    Done: [],
  };

  // The test descriptor's own marker scheme: a batch's marker label is 'test-marker'; a candidate's
  // own id rides on a 'test-id-<id>' label (mirrors veracodeLabelToIssueId/waltzLabelToDedupKey's
  // shape without pulling in either importer's real regex).
  function makeStaleIssue(key: string, issueType: string, ids: string[], status = 'Open') {
    return {
      key,
      fields: {
        summary: `Summary for ${key}`,
        status: { name: status },
        issuetype: { name: issueType },
        labels: ['test-marker', ...ids.map(id => `test-id-${id}`)],
      },
    };
  }

  function makeStaleDescriptor(activeIds: string[] = [], kind: 'veracode' | 'waltz' = 'veracode'): ReportImportDescriptor<TestItem, TestRow> {
    const activeSet = new Set(activeIds);
    return {
      ...descriptor,
      descriptorKind: kind,
      stale: {
        markerLabel: 'test-marker',
        labelToDedupKey: (label) => {
          const m = label.match(/^test-id-(.+)$/);
          return m ? m[1] : null;
        },
        buildActivePredicate: () => (id: string) => activeSet.has(id),
      },
    };
  }

  // Routes ticketService.searchTicketsRaw by JQL shape: the dedup search ("labels in (...)") always
  // comes back empty (these tests focus on the stale section, not dedup) and the stale search
  // ("labels = \"test-marker\"") returns whatever candidates the test supplies.
  function mockSearches(staleIssues: ReturnType<typeof makeStaleIssue>[] = []): ReturnType<typeof vi.spyOn> {
    return vi.spyOn(ticketService, 'searchTicketsRaw').mockImplementation(async (jql: string) => {
      if (jql.includes('labels in (')) return { issues: [], total: 0 };
      if (jql.includes('labels = "test-marker"')) return { issues: staleIssues as never, total: staleIssues.length, isLast: true };
      return { issues: [], total: 0 };
    });
  }

  function withRules(cleanupRules: unknown[]): void {
    vi.mocked(TemplateService).mockImplementation(() => ({
      loadTemplates: vi.fn().mockReturnValue({ templates: [], cleanupRules }),
    }) as never);
  }

  // Runs an import whose only result group is Stale and returns the stored review session.
  async function importStale(
    issues: ReturnType<typeof makeStaleIssue>[],
    ws: ReturnType<typeof makeMockWs>,
    staleDescriptor = makeStaleDescriptor(),
  ): Promise<ReviewSession<TestRow>> {
    mockSearches(issues);
    await continueAfterImportIssueType('Bug', null, makeSession({ items: [], availableIssueTypes: ['Bug'] }), client, ticketService, mockStream() as never, ws as never, staleDescriptor);
    return ws.store[descriptor.sessionKeys.review] as ReviewSession<TestRow>;
  }

  async function reply(text: string, ws: ReturnType<typeof makeMockWs>, staleDescriptor = makeStaleDescriptor()): Promise<string> {
    const stream = mockStream();
    const close = ws.store[CLOSE_KEY];
    if (close) {
      await continueStaleClose(text, close as never, stream as never, ws as never, staleDescriptor, ticketService);
    } else {
      await handleImportReviewReply(text, ws.store[descriptor.sessionKeys.review] as never, ticketService, stream as never, ws as never, staleDescriptor);
    }
    return (stream.markdown as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => markdownText(c[0])).join('\n');
  }

  beforeEach(() => {
    client = new MockJiraClient();
    ticketService = new TicketService(client);
    (vscode.workspace as { workspaceFolders?: unknown }).workspaceFolders = [{ uri: { fsPath: '/workspace' } }];
    vi.mocked(loadWorkflowCache).mockReturnValue({
      PROJ: {
        Bug: { discovered: '2024-01-01', graph: bugGraph },
        Vulnerability: { discovered: '2024-01-01', graph: { Open: [{ id: '31', name: 'Close', to: 'Done' }], Done: [] } },
      },
    });
    withRules([]);
  });

  afterEach(() => {
    (vscode.workspace as { workspaceFolders?: unknown }).workspaceFolders = undefined;
  });

  it('AE1: with no cleanup rule, a selected ticket can be moved to a non-final status and no resolution is asked', async () => {
    const ws = makeMockWs();
    const session = await importStale([makeStaleIssue('PROJ-1', 'Bug', ['1'])], ws);
    expect(session.staleTickets?.groups[0].tickets[0].included).toBe(false); // nothing selected by default

    await reply('PROJ-1', ws);
    const pick = await reply('close tickets', ws);
    expect(pick).toContain('Where should the **1** selected stale **Bug** ticket(s) go?');
    expect(pick).toContain('Done');
    expect(pick).toContain('Verification');
    expect(client.executeTransitionCalls).toHaveLength(0); // nothing moves before the pick

    const done = await reply('Verification', ws);
    expect(client.executeTransitionCalls).toEqual([{ issueKey: 'PROJ-1', transitionId: '11', fields: undefined }]);
    expect(done).toContain('**1** stale ticket(s) transitioned to **Verification**');
    expect(done).not.toContain('which resolution');
    expect(ws.store[CLOSE_KEY]).toBeUndefined();
  });

  it('AE2: picking a cleanup rule applies its target and its resolution without asking', async () => {
    withRules([{ name: 'Close released bugs', project: 'PROJ', issueType: 'Bug', targetState: 'Done', resolution: 'Fixed' }]);
    const ws = makeMockWs();
    await importStale([makeStaleIssue('PROJ-1', 'Bug', ['1'])], ws);

    await reply('PROJ-1', ws);
    const pick = await reply('close tickets', ws);
    expect(pick).toContain('Close released bugs → Done');

    const done = await reply('1', ws);
    expect(client.executeTransitionCalls).toEqual([{ issueKey: 'PROJ-1', transitionId: '12', fields: { resolution: { name: 'Fixed' } } }]);
    expect(done).not.toContain('which resolution');
  });

  it('a rule with a closing target and no resolution asks for one once, then transitions with the answer', async () => {
    withRules([{ name: 'close-bugs', project: 'PROJ', issueType: 'Bug', targetState: 'Done' }]);
    const ws = makeMockWs();
    await importStale([makeStaleIssue('PROJ-1', 'Bug', ['1'])], ws);

    await reply('PROJ-1', ws);
    await reply('close tickets', ws);
    const ask = await reply('close-bugs', ws);
    expect(ask).toContain('which resolution should be set?');
    expect(client.executeTransitionCalls).toHaveLength(0);

    await reply('Fixed', ws);
    expect(client.executeTransitionCalls).toEqual([{ issueKey: 'PROJ-1', transitionId: '12', fields: { resolution: { name: 'Fixed' } } }]);
  });

  it('a plain closing status asks for a resolution; "none" (or "skip") transitions without one', async () => {
    const ws = makeMockWs();
    await importStale([makeStaleIssue('PROJ-1', 'Bug', ['1']), makeStaleIssue('PROJ-2', 'Bug', ['2'])], ws);

    await reply('PROJ-1', ws);
    await reply('close tickets', ws);
    expect(await reply('Done', ws)).toContain('which resolution should be set?');
    await reply('none', ws);
    expect(client.executeTransitionCalls).toEqual([{ issueKey: 'PROJ-1', transitionId: '12', fields: undefined }]);

    await reply('PROJ-2', ws);
    await reply('close tickets', ws);
    await reply('Done', ws);
    await reply('skip', ws);
    expect(client.executeTransitionCalls.map(c => c.issueKey)).toEqual(['PROJ-1', 'PROJ-2']);
    expect(client.executeTransitionCalls[1].fields).toBeUndefined();
  });

  it('a stale ticket left at its default (unselected) does not transition on confirm', async () => {
    const ws = makeMockWs();
    await importStale([makeStaleIssue('PROJ-1', 'Bug', ['1'])], ws);

    const text = await reply('post it', ws);

    expect(text).toContain('Nothing selected');
    expect(ws.store[CLOSE_KEY]).toBeUndefined();
    expect(client.executeTransitionCalls).toHaveLength(0);
  });

  it('a stale ticket with no discovered workflow renders excluded with a note and cannot be toggled in', async () => {
    const ws = makeMockWs();
    const session = await importStale([makeStaleIssue('PROJ-2', 'Task', ['2'])], ws);
    expect(session.staleTickets?.groups).toEqual([]);
    expect(session.staleTickets?.ineligible[0]).toMatchObject({ key: 'PROJ-2' });
    expect(session.staleTickets?.ineligible[0].note).toContain('@jira discover workflow PROJ Task');

    expect(await reply('PROJ-2', ws)).toContain("Didn't understand that");
  });

  it('a resolution whose name is also a cancel word is set, not treated as going back', async () => {
    vi.spyOn(client, 'getResolutions').mockResolvedValue([{ name: 'Fixed' }, { name: 'Cancelled' }]);
    const ws = makeMockWs();
    await importStale([makeStaleIssue('PROJ-1', 'Bug', ['1'])], ws);
    await reply('PROJ-1', ws);
    await reply('close tickets', ws);
    expect(await reply('Done', ws)).toContain('which resolution should be set?');

    await reply('Cancelled', ws);

    expect(client.executeTransitionCalls).toEqual([{ issueKey: 'PROJ-1', transitionId: '12', fields: { resolution: { name: 'Cancelled' } } }]);
  });

  it('at the resolution step, a cancel word that names no resolution still goes back', async () => {
    const ws = makeMockWs();
    await importStale([makeStaleIssue('PROJ-1', 'Bug', ['1'])], ws);
    await reply('PROJ-1', ws);
    await reply('close tickets', ws);
    await reply('Done', ws);

    const back = await reply('stop', ws);

    expect(back).toContain('No stale tickets were transitioned');
    expect(client.executeTransitionCalls).toHaveLength(0);
  });

  it('AE4: "back" or a cancellation word at the target or resolution step returns to the Stale screen with nothing transitioned', async () => {
    const ws = makeMockWs();
    await importStale([makeStaleIssue('PROJ-1', 'Bug', ['1'])], ws);
    await reply('PROJ-1', ws);

    await reply('close tickets', ws);
    const back = await reply('back', ws);
    expect(back).toContain('No stale tickets were transitioned');
    expect(back).toContain('### Stale');
    expect(ws.store[CLOSE_KEY]).toBeUndefined();

    await reply('close tickets', ws);
    await reply('cancel', ws);
    expect(ws.store[CLOSE_KEY]).toBeUndefined();

    await reply('close tickets', ws);
    await reply('Done', ws);
    await reply('back', ws);
    expect(ws.store[CLOSE_KEY]).toBeUndefined();
    expect(client.executeTransitionCalls).toHaveLength(0);
  });

  it('AE5: a selected ticket with no path to the picked status is skipped with a note; the others are transitioned', async () => {
    const ws = makeMockWs();
    await importStale([
      makeStaleIssue('PROJ-1', 'Bug', ['1']),
      makeStaleIssue('PROJ-2', 'Bug', ['2'], 'Done'),
      makeStaleIssue('PROJ-3', 'Bug', ['3'], 'Verification'),
    ], ws);
    await reply('PROJ-1 PROJ-2 PROJ-3', ws);
    await reply('close tickets', ws);

    const done = await reply('Verification', ws);

    expect(client.executeTransitionCalls.map(c => c.issueKey)).toEqual(['PROJ-1']);
    expect(done).toContain('PROJ-2 skipped — no path found from Done to Verification');
    expect(done).toContain('PROJ-3 skipped — already in Verification');
    const after = ws.store[descriptor.sessionKeys.review] as ReviewSession<TestRow>;
    expect(after.staleTickets?.closedKeys).toEqual(['PROJ-1']);
    // Skipped tickets are deselected, so the next close doesn't just repeat the same skip.
    expect(after.staleTickets?.groups[0].tickets.filter(t => t.included).map(t => t.key)).toEqual(['PROJ-1']);
  });

  it('AE6: with Bug and Vulnerability tickets selected, one issue type is closed per run and the other stays selected', async () => {
    const ws = makeMockWs();
    await importStale([
      makeStaleIssue('PROJ-1', 'Bug', ['1']),
      makeStaleIssue('PROJ-2', 'Bug', ['2']),
      makeStaleIssue('PROJ-3', 'Vulnerability', ['3']),
    ], ws);
    await reply('PROJ-1 PROJ-2 PROJ-3', ws);

    const typeAsk = await reply('close tickets', ws);
    expect(typeAsk).toContain('Which issue type do you want to close now?');
    expect(typeAsk).toContain('Bug');
    expect(typeAsk).toContain('Vulnerability');

    const targetAsk = await reply('Bug', ws);
    expect(targetAsk).toContain('**2** selected stale **Bug**');
    expect(targetAsk).toContain('Verification'); // Bug's workflow, not Vulnerability's

    const done = await reply('Verification', ws);
    expect(client.executeTransitionCalls.map(c => c.issueKey)).toEqual(['PROJ-1', 'PROJ-2']);
    const after = ws.store[descriptor.sessionKeys.review] as ReviewSession<TestRow>;
    expect(after.view).toBe('stale');
    expect(done).toContain('### Stale');
    const vuln = after.staleTickets?.groups.find(g => g.issueType === 'Vulnerability');
    expect(vuln?.tickets[0].included).toBe(true);

    // The next close goes straight to the target pick for the one remaining issue type.
    expect(await reply('close tickets', ws)).toContain('**1** selected stale **Vulnerability**');
  });

  it('AE4: "back" at the issue-type step returns to the Stale screen', async () => {
    const ws = makeMockWs();
    await importStale([makeStaleIssue('PROJ-1', 'Bug', ['1']), makeStaleIssue('PROJ-3', 'Vulnerability', ['3'])], ws);
    await reply('PROJ-1 PROJ-3', ws);
    await reply('close tickets', ws);

    expect(await reply('back', ws)).toContain('### Stale');
    expect(ws.store[CLOSE_KEY]).toBeUndefined();
    expect(client.executeTransitionCalls).toHaveLength(0);
  });

  it('an unrecognized reply at a step shows the same step again', async () => {
    const ws = makeMockWs();
    await importStale([makeStaleIssue('PROJ-1', 'Bug', ['1'])], ws);
    await reply('PROJ-1', ws);
    await reply('close tickets', ws);

    const again = await reply('Archived', ws);

    expect(again).toContain("Didn't understand that");
    expect(again).toContain('Where should the **1** selected stale **Bug** ticket(s) go?');
    expect((ws.store[CLOSE_KEY] as { step: string }).step).toBe('pick-target');
  });

  it('when no rule matches and the selected tickets can reach nothing, close explains and asks nothing', async () => {
    const ws = makeMockWs();
    await importStale([makeStaleIssue('PROJ-2', 'Bug', ['2'], 'Done')], ws);
    await reply('PROJ-2', ws);

    const text = await reply('close tickets', ws);

    expect(text).toContain("can't reach any status in the discovered workflow");
    expect(text).toContain('@jira discover workflow PROJ Bug');
    expect(ws.store[CLOSE_KEY]).toBeUndefined();
    expect(client.executeTransitionCalls).toHaveLength(0);
  });

  it('when every selected ticket is skipped, the run transitions nothing and says why for each', async () => {
    withRules([{ name: 'verify-bugs', project: 'PROJ', issueType: 'Bug', targetState: 'Verification' }]);
    const ws = makeMockWs();
    await importStale([makeStaleIssue('PROJ-2', 'Bug', ['2'], 'Done')], ws);
    await reply('PROJ-2', ws);
    await reply('close tickets', ws);

    const done = await reply('verify-bugs', ws);

    expect(client.executeTransitionCalls).toHaveLength(0);
    expect(done).toContain('**0** stale ticket(s) transitioned to **Verification**, 0 failed, 1 skipped.');
    expect(done).toContain('PROJ-2 skipped — no path found from Done to Verification');
  });

  it('the overview counts tickets that cannot be closed without blaming a missing cleanup rule', async () => {
    const ws = makeMockWs();
    mockSearches([makeStaleIssue('PROJ-1', 'Bug', ['1']), makeStaleIssue('PROJ-2', 'Task', ['2'])]);
    const stream = mockStream();
    await continueAfterImportIssueType('Bug', null, makeSession({ items: [{ ref: 'n-1' }], availableIssueTypes: ['Bug'] }), client, ticketService, stream as never, ws as never, makeStaleDescriptor());

    const overview = markdownText((stream.markdown as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0]);
    expect(overview).toContain('1 not closable (no discovered workflow)');
    expect(overview).not.toContain('cleanup rule');
  });

  it('a second "close tickets" never re-transitions a ticket that was already transitioned', async () => {
    const ws = makeMockWs();
    await importStale([makeStaleIssue('PROJ-1', 'Bug', ['1'])], ws);
    await reply('PROJ-1', ws);
    await reply('close tickets', ws);
    await reply('Verification', ws);

    const text = await reply('ok', ws);

    expect(client.executeTransitionCalls).toHaveLength(1);
    expect(text).toContain('Nothing selected');
    expect(text).toContain('✓ closed');
  });

  it('R9: the close session records a Waltz import as Waltz, so the participant routes its answers back to Waltz', async () => {
    const ws = makeMockWs();
    const waltz = makeStaleDescriptor([], 'waltz');
    await importStale([makeStaleIssue('PROJ-1', 'Bug', ['1'])], ws, waltz);
    await reply('PROJ-1', ws, waltz);
    await reply('close tickets', ws, waltz);

    expect((ws.store[CLOSE_KEY] as { descriptorKind: string }).descriptorKind).toBe('waltz');
    await reply('Verification', ws, waltz);
    expect(client.executeTransitionCalls.map(c => c.issueKey)).toEqual(['PROJ-1']);
  });

  it('an answer after a newer import claimed the session key transitions nothing', async () => {
    const ws = makeMockWs();
    await importStale([makeStaleIssue('PROJ-1', 'Bug', ['1'])], ws);
    await reply('PROJ-1', ws);
    await reply('close tickets', ws);
    ws.store[descriptor.sessionKeys.templateSelection] = { projectKey: 'PROJ' }; // a newer import started

    const text = await reply('Verification', ws);

    expect(text).toContain('A newer import was started');
    expect(ws.store[CLOSE_KEY]).toBeUndefined();
    expect(client.executeTransitionCalls).toHaveLength(0);
  });

  it('F1: overview → close a stale ticket → create new rows → done, each group acting only on its own rows', async () => {
    withRules([{ name: 'close-bugs', project: 'PROJ', issueType: 'Bug', targetState: 'Done', resolution: 'Fixed' }]);
    mockSearches([makeStaleIssue('PROJ-1', 'Bug', ['1'])]);
    const templateSession = makeSession({ items: [{ ref: 'new-1' }, { ref: 'new-2' }], availableIssueTypes: ['Bug'] });
    const ws = makeMockWs();
    const staleDescriptor = makeStaleDescriptor();

    const stream0 = mockStream();
    await continueAfterImportIssueType('Bug', null, templateSession, client, ticketService, stream0 as never, ws as never, staleDescriptor);
    const first = markdownText((stream0.markdown as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0]);
    expect(first).toContain('### Import results');
    expect(first.toLowerCase()).not.toContain('post it');

    await reply('open stale', ws);
    await reply('PROJ-1', ws);
    await reply('close tickets', ws);
    const closeText = await reply('close-bugs', ws);
    expect(client.executeTransitionCalls.map(c => c.issueKey)).toEqual(['PROJ-1']);
    expect(client.createIssueCalls).toHaveLength(0); // closing touched nothing in New (R11)
    const session = ws.store[descriptor.sessionKeys.review] as ReviewSession<TestRow>;
    expect(session.view).toBe('overview');
    expect(closeText).toContain('1 closed');

    await reply('open new', ws);
    await reply('create tickets', ws);
    expect(client.createIssueCalls).toHaveLength(2);
    expect(client.executeTransitionCalls).toHaveLength(1); // creating touched nothing in Stale (R11)

    const doneText = await reply('done', ws);
    expect(ws.store[descriptor.sessionKeys.review]).toBeUndefined();
    expect(doneText.split('\n').at(-1)).toBe('Import finished — **2** created, 0 updated, 0 follow-ups, 0 re-created, 1 closed.');
  });

  it('a reply is read only against the screen showing: a row id on the Stale screen and a ticket key on the New screen are rejected (R6/AE2)', async () => {
    mockSearches([makeStaleIssue('PROJ-123', 'Bug', ['1'])]);
    const templateSession = makeSession({ items: [{ ref: '2' }], availableIssueTypes: ['Bug'] });
    const ws = makeMockWs();
    const staleDescriptor = makeStaleDescriptor();
    await continueAfterImportIssueType('Bug', null, templateSession, client, ticketService, mockStream() as never, ws as never, staleDescriptor);
    const session = ws.store[descriptor.sessionKeys.review] as ReviewSession<TestRow>;

    await handleImportReviewReply('open new', session, ticketService, mockStream() as never, ws as never, staleDescriptor);
    const streamNew = mockStream();
    await handleImportReviewReply('PROJ-123', session, ticketService, streamNew as never, ws as never, staleDescriptor);
    expect(markdownText((streamNew.markdown as ReturnType<typeof vi.fn>).mock.calls[0][0])).toContain("Didn't understand that");
    expect(session.staleTickets?.groups[0].tickets[0].included).toBe(false);

    await handleImportReviewReply('back', session, ticketService, mockStream() as never, ws as never, staleDescriptor);
    await handleImportReviewReply('open stale', session, ticketService, mockStream() as never, ws as never, staleDescriptor);
    const streamStale = mockStream();
    await handleImportReviewReply('1', session, ticketService, streamStale as never, ws as never, staleDescriptor);
    expect(markdownText((streamStale.markdown as ReturnType<typeof vi.fn>).mock.calls[0][0])).toContain("Didn't understand that");
    expect(session.rows.find(r => r.id === '1')!.included).toBe(true); // untouched

    // A mixed reply is rejected whole rather than half-applied.
    await handleImportReviewReply('PROJ-123 1', session, ticketService, mockStream() as never, ws as never, staleDescriptor);
    expect(session.staleTickets?.groups[0].tickets[0].included).toBe(false);
  });

  // Code-review fix regression test: the truncation-coverage warning used to be nested inside
  // `stale.length > 0`, so it silently never rendered when a truncated search's checked candidates
  // all turned out non-stale — defeating KTD10's "must not silently lose coverage" guarantee.
  it('the truncation-coverage warning renders even when none of the checked candidates turned out stale', async () => {
    vi.mocked(TemplateService).mockImplementation(() => ({
      loadTemplates: vi.fn().mockReturnValue({ templates: [], cleanupRules: [] }),
    }) as never);
    vi.spyOn(ticketService, 'searchTicketsRaw').mockImplementation(async (jql: string) => {
      if (jql.includes('labels in (')) return { issues: [], total: 0 };
      if (jql.includes('labels = "test-marker"')) {
        // The one checked candidate is still active (not stale), but the search itself hit the cap.
        return { issues: [makeStaleIssue('PROJ-1', 'Bug', ['1'])], total: 200, isLast: false };
      }
      return { issues: [], total: 0 };
    });
    const staleDescriptor = makeStaleDescriptor(['1']); // '1' active -> PROJ-1 is not stale
    const templateSession = makeSession({ items: [], availableIssueTypes: ['Bug'] });
    const stream = mockStream();
    const ws = makeMockWs();

    await continueAfterImportIssueType('Bug', null, templateSession, client, ticketService, stream as never, ws as never, staleDescriptor);

    const text = (stream.markdown as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => markdownText(c[0])).join('\n');
    expect(text).toContain('Checked the first');
    expect(text).toContain('200');
  });

  // Code-review fix regression test: buildStaleTicketGroups() (and the synchronous
  // TemplateService.loadTemplates() it calls internally) had no guard, unlike the dedup-search
  // block right above it — a throw here used to propagate out and discard the whole in-progress
  // review instead of degrading gracefully.
  it('a failure inside buildStaleTicketGroups (e.g. a malformed templates file) degrades gracefully instead of discarding the whole review', async () => {
    vi.mocked(TemplateService).mockImplementation(() => ({
      loadTemplates: vi.fn().mockImplementation(() => { throw new Error('Malformed .jira-templates.json'); }),
    }) as never);
    mockSearches([makeStaleIssue('PROJ-1', 'Bug', ['1'])]);
    const templateSession = makeSession({ items: [{ ref: '2' }], availableIssueTypes: ['Bug'] });
    const stream = mockStream();
    const ws = makeMockWs();
    const staleDescriptor = makeStaleDescriptor();

    await continueAfterImportIssueType('Bug', null, templateSession, client, ticketService, stream as never, ws as never, staleDescriptor);

    // The review session survived and was rendered/persisted — not discarded by the throw.
    const reviewSession = ws.store[descriptor.sessionKeys.review] as ReviewSession<TestRow> | undefined;
    expect(reviewSession).toBeDefined();
    expect(reviewSession!.staleTickets).toBeUndefined();

    const text = (stream.markdown as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => markdownText(c[0])).join('\n');
    expect(text).toContain('could not check for stale tickets');
  });
});
