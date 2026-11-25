import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BitbucketConfig, BitbucketPR } from '../bitbucket/IBitbucketClient';
import type { BoardModelHandle } from '../boards/boardModels';
import type { ReviewBoardDeps } from '../boards/review/deps';
import { reviewKind, type ReviewView, type ReviewWorking } from '../boards/review/kind';
import { REVIEW_KIND, reviewSessionId } from '../boards/review/recipe';
import { registerKind } from '../sessions/boardKind';
import { SessionManager, type BoardState } from '../sessions/sessionManager';
import { SessionStore } from '../sessions/sessionStore';
import type { BitbucketToolDeps, StoredReview } from '../tools/bitbucketTools/bitbucketAccess';
import { BITBUCKET_TOOLS } from '../tools/bitbucketTools/catalog';
import { reviewVerdict } from '../tools/bitbucketTools/readFindings';
import { confirmationWithPreview } from '../tools/jiraToolConfirmation';
import { RecentCallGuard } from '../tools/recentCallGuard';
import { callTool } from '../tools/toolDefinition';
import { USAGE_STORAGE_KEY, type UsageStore } from '../utils/tokenUsage';
import { MockBitbucketClient } from './mocks/MockBitbucketClient';

// The Bitbucket tools as Copilot calls them, through `callTool`: the pull request reads, the
// comment post with its confirmation and duplicate guard, the connection check, the token usage,
// and the two review tools over a real review board session (a regular pass run with a scripted
// model, then read again after a restart).

const PR_URL = 'https://bitbucket.example.com/projects/PROJ/repos/app/pull-requests/482';
const HEAD = 'abc123def456abc123def456abc123def456abc1';
const MODEL = { id: 'gpt-review', name: 'GPT Review', vendor: 'copilot', family: 'gpt' };
const DC_CONFIG: BitbucketConfig = { baseUrl: 'https://bitbucket.example.com', authType: 'datacenter', token: 'secret-token' };

/** Counts every Bitbucket request, so a scenario can say none was made. */
class CountingClient extends MockBitbucketClient {
  prReads = 0;
  userReads = 0;
  failUser?: Error;
  override async getPullRequest(project: string, repo: string, prId: number): Promise<BitbucketPR> {
    this.prReads++;
    return super.getPullRequest(project, repo, prId);
  }
  override async getCurrentUser() {
    this.userReads++;
    if (this.failUser) throw this.failUser;
    return super.getCurrentUser();
  }
}

function codeLine(line: number): string {
  return `export const value${line} = compute(${line}); // keeps the diff long enough`;
}

const DIFF = `diff --git a/src/f1.ts b/src/f1.ts\n--- a/src/f1.ts\n+++ b/src/f1.ts\n@@ -0,0 +1,8 @@\n${Array.from({ length: 8 }, (_, l) => `+${codeLine(l + 1)}`).join('\n')}\n`;

function findingLine(line: number, title: string, severity: string): string {
  return JSON.stringify({ file: 'src/f1.ts', line, anchorCode: codeLine(line), severity, confidence: 0.9, title, description: `${title} described`, recommendation: `Fix **${title}**` });
}

const REVIEW_REPLY = [
  findingLine(2, 'Unchecked input', 'warning'),
  findingLine(4, 'SQL built from input', 'critical'),
  findingLine(6, 'Name could be clearer', 'suggestion'),
  JSON.stringify({ additionalFilesNeeded: [] }),
].join('\n');

let dir: string;
let client: CountingClient;
let config: BitbucketConfig;
let usage: UsageStore;
let opened: unknown[];
let modelCalls: number;

function handle(id: string): BoardModelHandle {
  return {
    id,
    maxInputTokens: 100_000,
    countTokens: async text => Math.ceil((typeof text === 'string' ? text : text.content).length / 4),
    sendRequest: async () => {
      modelCalls++;
      return { text: (async function* () { yield REVIEW_REPLY; })() };
    },
  };
}

function boardDeps(): ReviewBoardDeps {
  return {
    bitbucket: async () => ({ configured: true, client }),
    jira: async () => ({
      readRequirements: async key => ({
        ok: true,
        source: { key, summary: 'Add export', descriptionText: 'Export the report as CSV.', truncatedDescription: false, comments: [], omittedComments: 0, commentsUnavailable: false },
      }),
    }),
    models: { list: async () => [MODEL], handle: async id => (id === MODEL.id ? handle(id) : undefined) },
    modelSettings: { reviewModel: () => MODEL.id, writeReviewModel: async () => {} },
    settings: async () => ({ confidenceThreshold: 0.7, modelContextTokens: 60_000 }),
    recordTokens: async () => {},
    confirm: async () => true,
    now: () => 1_000,
    sleep: async () => {},
  };
}

/** A session manager over the stored sessions, as at a VS Code start. */
function manager(): SessionManager {
  return new SessionManager({ store: new SessionStore(dir), kinds: [registerKind(reviewKind, boardDeps)], now: () => 1_000, confirm: async () => true, saveFile: async () => true });
}

function toolDeps(m: SessionManager = manager()): BitbucketToolDeps {
  return {
    getBitbucket: async () => (config.authType === 'cloud' ? !!config.token : !!(config.baseUrl && config.token))
      ? { configured: true, config, client }
      : { configured: false, config },
    recentWrites: new RecentCallGuard(),
    openReview: async input => {
      opened.push(input);
      const result = await m.open(REVIEW_KIND, input);
      return result.ok ? { ok: true, title: result.title } : result;
    },
    storedReview: async id => (await m.peek(REVIEW_KIND, id)) as StoredReview | undefined,
    tokenUsage: () => usage,
    now: () => new Date('2026-11-19T12:00:00Z'),
  };
}

function tool(name: string) {
  const found = BITBUCKET_TOOLS.find(t => t.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return found;
}

async function idle(m: SessionManager, id: string): Promise<BoardState> {
  let state = await m.state(REVIEW_KIND, id);
  while (state.running || state.status === 'building' || state.status === 'checking') state = await m.state(REVIEW_KIND, id, state.tick, 1000);
  return state;
}

/** Runs a regular pass on the review board of the pull request, opened with the ticket key PROJ-12. */
async function reviewOnBoard(): Promise<string> {
  const m = manager();
  const result = await m.open(REVIEW_KIND, { url: PR_URL, ticketKey: 'PROJ-12' });
  if (!result.ok) throw new Error(result.reason);
  const state = await idle(m, result.id);
  await m.startRun(REVIEW_KIND, state.id, state.revision, { type: 'start' });
  await idle(m, state.id);
  return state.id;
}

/** Changes the stored working state, as later work on the board would have. */
async function storeWork(id: string, change: (working: ReviewWorking) => ReviewWorking): Promise<void> {
  const store = new SessionStore(dir);
  const stored = (await store.load(id))!.session;
  await store.save({ ...stored, working: change(stored.working as ReviewWorking) });
}

function numberOf(working: ReviewWorking, title: string): number {
  return working.review!.store.findings.find(f => f.title === title)!.id;
}

async function storedWorking(id: string): Promise<ReviewWorking> {
  return (await new SessionStore(dir).load(id))!.session.working as ReviewWorking;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitbucket-tools-'));
  client = new CountingClient();
  client.rawDiff = DIFF;
  client.prOverride = { id: 482, title: 'Add export', fromCommitHash: HEAD };
  config = { ...DC_CONFIG };
  usage = {};
  opened = [];
  modelCalls = 0;
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('bitbucket_read_findings', () => {
  it('names in the summary what the review did not review and the findings it dropped', async () => {
    const id = await reviewOnBoard();
    await storeWork(id, working => ({
      ...working,
      passes: [
        { ...working.passes[0], notes: ['regular batch 2/3 — could not review src/report.ts after retrying: overloaded', '1 file excluded by pattern.'], droppedOutsidePr: 2 },
        { ...working.passes[0], step: 'critic', notes: [], droppedOutsidePr: 0, removed: [4], run: 2 },
      ],
    }));

    const result = await callTool(tool('bitbucket_read_findings'), { url: PR_URL }, toolDeps());

    expect(result.text).toContain([
      'Not reviewed or dropped:',
      '- regular batch 2/3 — could not review src/report.ts after retrying: overloaded',
      '- 1 file excluded by pattern.',
      '- 2 findings were dropped because they named files outside this pull request.',
      '- 1 finding was removed by the critic as unverifiable: #4.',
    ].join('\n'));
  });

  it('says nothing about dropped findings when the review left nothing out', async () => {
    await reviewOnBoard();
    const result = await callTool(tool('bitbucket_read_findings'), { url: PR_URL }, toolDeps());
    expect(result.text).not.toContain('Not reviewed or dropped');
  });

  it('for a stored review answers the counts by severity, the passes run and the verdict, with no requirements coverage, and starts no check', async () => {
    await reviewOnBoard();
    const restarted = manager();
    const readsBefore = client.prReads;
    const callsBefore = modelCalls;

    const result = await callTool(tool('bitbucket_read_findings'), { url: `${PR_URL}/overview` }, toolDeps(restarted));

    expect(result.failed).toBe(false);
    expect(result.text).toContain('Review of PROJ/app#482: Add export');
    expect(result.text).toContain('Passes run: Regular');
    expect(result.text).toContain('Findings: 3 (1 critical, 1 warnings, 1 suggestions)');
    expect(result.text).toContain('Verdict: critical issues');
    expect(result.text).not.toMatch(/coverage/i);
    const list = await callTool(tool('bitbucket_read_findings'), { url: PR_URL, list: true }, toolDeps(restarted));
    expect(list.text).not.toMatch(/coverage/i);
    expect(client.prReads).toBe(readsBefore);
    expect(modelCalls).toBe(callsBefore);
  });

  it('after a restart, with finding 3, returns #3\'s code from the diff and its explanation', async () => {
    const id = await reviewOnBoard();
    const working = await storedWorking(id);
    const three = working.review!.store.findings.find(f => f.id === 3)!;
    await storeWork(id, w => ({ ...w, threads: { '3': [{ answer: 'The **input** reaches the query `as is`.' }, { question: 'Is it *reachable*?', answer: 'Yes, from the **form**.' }] } }));

    const result = await callTool(tool('bitbucket_read_findings'), { url: PR_URL, finding: 3 }, toolDeps(manager()));

    expect(result.text).toContain(`Finding #3 (${three.severity}) at src/f1.ts:${three.line}`);
    expect(result.text).toContain(`Title: ${three.title}`);
    expect(result.text).toContain('Code from the diff:');
    expect(result.text).toContain(codeLine(three.line!));
    // The discussion comes back as plain text, without its Markdown.
    expect(result.text).toContain('Discussion:\nQuestion: Explain\nAnswer: The input reaches the query as is.\n\nQuestion: Is it reachable?\nAnswer: Yes, from the form.');
    expect(result.text).toContain(`Recommendation: Fix ${three.title}`);
  });

  it('names the "against goal" mark in the list and in one finding', async () => {
    const id = await reviewOnBoard();
    const working = await storedWorking(id);
    const marked = numberOf(working, 'Unchecked input');
    await storeWork(id, w => ({
      ...w,
      review: { ...w.review!, store: { ...w.review!.store, findings: w.review!.store.findings.map(f => (f.id === marked ? { ...f, againstGoal: true as const } : f)) } },
    }));
    const deps = toolDeps(manager());

    const list = await callTool(tool('bitbucket_read_findings'), { url: PR_URL, list: true }, deps);
    expect(list.text).toContain(`#${marked} warning src/f1.ts:2: Unchecked input (against goal)`);
    const one = await callTool(tool('bitbucket_read_findings'), { url: PR_URL, finding: marked }, deps);
    expect(one.text).toContain('Marked: against goal');
  });

  it('lists every finding by severity, and leaves a finding labelled probably a false alarm out of the verdict', async () => {
    const id = await reviewOnBoard();
    const working = await storedWorking(id);
    const critical = numberOf(working, 'SQL built from input');
    await storeWork(id, w => ({
      ...w,
      review: { ...w.review!, store: { ...w.review!.store, findings: w.review!.store.findings.map(f => (f.id === critical ? { ...f, probablyFalseAlarm: true as const } : f)) } },
    }));
    const deps = toolDeps(manager());

    const list = await callTool(tool('bitbucket_read_findings'), { url: PR_URL, list: true }, deps);
    const lines = list.text.split('\n').filter(l => l.startsWith('#'));
    expect(lines).toEqual([
      `#${critical} critical src/f1.ts:4: SQL built from input (probably a false alarm)`,
      `#${numberOf(working, 'Unchecked input')} warning src/f1.ts:2: Unchecked input`,
      `#${numberOf(working, 'Name could be clearer')} suggestion src/f1.ts:6: Name could be clearer`,
    ]);
    const summary = await callTool(tool('bitbucket_read_findings'), { url: PR_URL }, deps);
    expect(summary.text).toContain('Verdict: warnings');
    expect(summary.text).toContain('1 labelled probably a false alarm');
  });

  it('marks in the list which findings have a draft, which were posted (with the comment id) and whose post failed', async () => {
    const id = await reviewOnBoard();
    const working = await storedWorking(id);
    const critical = numberOf(working, 'SQL built from input');
    const warning = numberOf(working, 'Unchecked input');
    const suggestion = numberOf(working, 'Name could be clearer');
    await storeWork(id, w => ({
      ...w,
      drafts: {
        [critical]: { text: 'Please use a bound parameter.', posted: { commentId: 100 } },
        [warning]: { text: 'Validate the input.', postError: 'Bitbucket said 500' },
        [suggestion]: { text: 'Maybe rename it.' },
      },
    }));

    const list = await callTool(tool('bitbucket_read_findings'), { url: PR_URL, list: true }, toolDeps(manager()));

    const lines = list.text.split('\n').filter(l => l.startsWith('#'));
    expect(lines).toEqual([
      `#${critical} critical src/f1.ts:4: SQL built from input (posted as comment 100)`,
      `#${warning} warning src/f1.ts:2: Unchecked input (drafted, post failed)`,
      `#${suggestion} suggestion src/f1.ts:6: Name could be clearer (drafted)`,
    ]);
  });

  it('with one finding, gives its draft as plain text next to the explanation, and whether it was posted or its post failed', async () => {
    const id = await reviewOnBoard();
    const working = await storedWorking(id);
    const critical = numberOf(working, 'SQL built from input');
    const warning = numberOf(working, 'Unchecked input');
    const suggestion = numberOf(working, 'Name could be clearer');
    await storeWork(id, w => ({
      ...w,
      threads: { [critical]: [{ answer: 'The id reaches the query.' }] },
      drafts: {
        [critical]: { text: 'Please use a **bound** parameter.', posted: { commentId: 100 } },
        [warning]: { text: 'Validate the input.', postError: 'Bitbucket said 500' },
      },
    }));
    const deps = toolDeps(manager());

    const posted = await callTool(tool('bitbucket_read_findings'), { url: PR_URL, finding: critical }, deps);
    expect(posted.text).toContain('Discussion:\nQuestion: Explain\nAnswer: The id reaches the query.\n\nDraft comment, posted as comment 100:\nPlease use a bound parameter.');
    const failed = await callTool(tool('bitbucket_read_findings'), { url: PR_URL, finding: warning }, deps);
    expect(failed.text).toContain('Draft comment, not posted: the last post failed (Bitbucket said 500):\nValidate the input.');
    const none = await callTool(tool('bitbucket_read_findings'), { url: PR_URL, finding: suggestion }, deps);
    expect(none.text).toContain('No draft comment: selecting the finding on the board drafts one.');
  });

  it('names the verdict from the highest severity found', () => {
    expect(reviewVerdict([])).toBe('no findings');
    expect(reviewVerdict([{ severity: 'suggestion' }])).toBe('suggestions only');
    expect(reviewVerdict([{ severity: 'suggestion' }, { severity: 'warning' }])).toBe('warnings');
    expect(reviewVerdict([{ severity: 'critical', probablyFalseAlarm: true }])).toBe('no findings');
  });

  it('for a pull request with no stored review answers that there is none and how to start one', async () => {
    const result = await callTool(tool('bitbucket_read_findings'), { url: PR_URL }, toolDeps());
    expect(result.text).toBe(`No review of ${PR_URL} is stored. Start one with bitbucket_open_review, which opens the review board, or with the Command Palette command "Ticket Sidekick: Review a pull request".`);
  });

  it('says so when the board is open but no review has run on it', async () => {
    const m = manager();
    await callTool(tool('bitbucket_open_review'), { url: PR_URL }, toolDeps(m));
    const shown = await m.open(REVIEW_KIND, { url: PR_URL });
    if (shown.ok) await idle(m, shown.id);
    const result = await callTool(tool('bitbucket_read_findings'), { url: PR_URL }, toolDeps(m));
    expect(result.text).toMatch(/is open, but no review has run on it yet/);
  });

  it('answers a finding number the review does not have with the numbers it has', async () => {
    await reviewOnBoard();
    const result = await callTool(tool('bitbucket_read_findings'), { url: PR_URL, finding: 9 }, toolDeps());
    expect(result.text).toBe('There is no finding #9 in this review. Its findings are #2, #1, #3.');
  });
});

describe('bitbucket_open_review', () => {
  it('answers "opened" without waiting for the review: the board stops on its first step with the background text, and nothing is reviewed', async () => {
    const m = manager();
    const result = await callTool(tool('bitbucket_open_review'), { url: PR_URL, ticketKey: 'PROJ-12', background: 'watch thread safety' }, toolDeps(m));

    expect(result.text).toMatch(/^Opened in an editor tab: .+\. The review runs on the board when the user starts it; read its result with bitbucket_read_findings\.$/);
    expect(opened).toEqual([{ url: PR_URL, ticketKey: 'PROJ-12', background: 'watch thread safety' }]);
    const state = await idle(m, reviewSessionId({ url: PR_URL }));
    expect((state.view as ReviewView).firstStep).toMatchObject({ choice: 'text', ownText: 'watch thread safety', ticketKey: 'PROJ-12' });
    expect(client.getPullRequestDiffCalls).toEqual([]);
    expect(modelCalls).toBe(0);
  });

  it('on a review past the first step, says the board keeps its background and New review starts over', async () => {
    await reviewOnBoard();
    const result = await callTool(tool('bitbucket_open_review'), { url: PR_URL, background: 'watch thread safety' }, toolDeps());
    expect(result.text).toContain('A review of this pull request is shown already, so the board keeps its background; New review on the board starts over on the first step, where the background can be changed.');
  });

  it('answers the reason when the link is not a pull request', async () => {
    const result = await callTool(tool('bitbucket_open_review'), { url: 'https://bitbucket.example.com/projects/PROJ/repos/app/browse' }, toolDeps());
    expect(result.text).toMatch(/^Not opened: That is not the link of a Bitbucket pull request/);
  });
});

describe('the pull request tools', () => {
  it('bitbucket_getPullRequest answers the title, author and target branch', async () => {
    const result = await callTool(tool('bitbucket_getPullRequest'), { project: 'PROJ', repo: 'app', prId: 482 }, toolDeps());
    expect(result.text).toContain('## PR #482 — Add export');
    expect(result.text).toContain('Author: Jane Smith');
  });

  it('bitbucket_getPullRequestDiff asks for the configured context lines when the call gives none', async () => {
    config.reviewContextLines = 7;
    const result = await callTool(tool('bitbucket_getPullRequestDiff'), { project: 'PROJ', repo: 'app', prId: 482 }, toolDeps());
    expect(result.text).toContain('## Diff for PR #482 (PROJ/app)');
    expect(client.getPullRequestDiffCalls).toEqual([{ project: 'PROJ', repo: 'app', prId: 482, contextLines: 7 }]);
  });

  it('refuses a repository value that would leave its path segment, and asks nothing', async () => {
    const result = await callTool(tool('bitbucket_getPullRequest'), { project: 'PROJ', repo: '../admin', prId: 1 }, toolDeps());
    expect(result.text).toBe('The project/workspace or repo value is not valid.');
    expect(client.prReads).toBe(0);
  });
});

describe('bitbucket_postComment', () => {
  const input = { project: 'PROJ', repo: 'app', prId: 482, comment: 'The export looks good to me.' };

  it('shows the comment text in its confirmation', async () => {
    const asked = await confirmationWithPreview(tool('bitbucket_postComment'), input, toolDeps());
    expect(asked.title).toBe('Post a comment on a Bitbucket pull request?');
    expect(asked.lines).toContainEqual({ name: 'comment', value: 'The export looks good to me.' });
  });

  it('shows a long comment in full in its confirmation, as it will be posted', async () => {
    const long = `${'The export streams every row. '.repeat(66)}End of comment.`;
    expect(long.length).toBeGreaterThan(1900);
    const asked = await confirmationWithPreview(tool('bitbucket_postComment'), { ...input, comment: `  ${long}\n` }, toolDeps());
    expect(asked.lines).toContainEqual({ name: 'Comment to post', value: long });
    expect(asked.lines.some(line => line.value.endsWith('…'))).toBe(true);
  });

  it('refuses a comment too long to be shown in full in its confirmation, and posts nothing', async () => {
    const tooLong = 'x'.repeat(60_001);
    const asked = await confirmationWithPreview(tool('bitbucket_postComment'), { ...input, comment: tooLong }, toolDeps());
    expect(asked.lines.some(line => line.value === tooLong)).toBe(false);
    const result = await callTool(tool('bitbucket_postComment'), { ...input, comment: tooLong }, toolDeps());
    expect(result.text).toBe('The comment is 60001 characters long; at most 60000 can be shown in full for confirmation, so it was not posted. Shorten it or split it into several comments.');
    expect(client.addPrCommentCalls).toEqual([]);
  });

  it('posts the comment to the activity feed, and skips an identical call within a minute', async () => {
    const deps = toolDeps();
    const first = await callTool(tool('bitbucket_postComment'), input, deps);
    expect(first.text).toBe('Posted comment #100 on PR #482 (PROJ/app).');
    expect(client.addPrCommentCalls).toEqual([{ project: 'PROJ', repo: 'app', prId: 482, text: 'The export looks good to me.', inline: undefined }]);

    const again = await callTool(tool('bitbucket_postComment'), input, deps);
    expect(again.text).toMatch(/^Skipped: an identical comment on PR #482 \(PROJ\/app\) was just posted/);
    expect(client.addPrCommentCalls).toHaveLength(1);
  });

  it('answers a failed post as failed, and lets a retry through', async () => {
    const deps = toolDeps();
    client.addPrCommentError = new Error('502 Bad Gateway');
    const failed = await callTool(tool('bitbucket_postComment'), input, deps);
    expect(failed).toMatchObject({ failed: true, text: 'Could not post the comment on PR #482 (PROJ/app): 502 Bad Gateway' });
    client.addPrCommentError = null;
    expect((await callTool(tool('bitbucket_postComment'), input, deps)).text).toBe('Posted comment #200 on PR #482 (PROJ/app).');
  });
});

describe('bitbucket_check_connection', () => {
  it('reports the signed-in user and the settings, never the token', async () => {
    const result = await callTool(tool('bitbucket_check_connection'), {}, toolDeps());
    expect(result.text).toContain('**Bitbucket connection OK**');
    expect(result.text).toContain('| Logged in as | Jane Smith |');
    expect(result.text).toContain('| Token | present (12 chars) |');
    expect(result.text).not.toContain('secret-token');
  });

  it('names a malformed Data Center base URL before trying to connect', async () => {
    config.baseUrl = 'bitbucket.example.com';
    const result = await callTool(tool('bitbucket_check_connection'), {}, toolDeps());
    expect(result.text).toMatch(/^\*\*Bitbucket configuration problem\*\*/);
    expect(client.userReads).toBe(0);
  });

  it('answers a failed connection as failed, with the error', async () => {
    client.failUser = Object.assign(new Error('401 Unauthorized'), { status: 401 });
    const result = await callTool(tool('bitbucket_check_connection'), {}, toolDeps());
    expect(result).toMatchObject({ failed: true, error: 'HTTP 401' });
    expect(result.text).toContain('Error: 401 Unauthorized');
  });
});

describe('bitbucket_token_usage', () => {
  it('shows the monthly per-model token table', async () => {
    usage = { '2026-11': { 'gpt-review': { input: 12_000, output: 3_400, calls: 5, estimated: false } } };
    const result = await callTool(tool('bitbucket_token_usage'), {}, toolDeps());
    expect(result.text).toContain('| 2026-11 | gpt-review | 12,000 | 3,400 | 5 |');
    expect(USAGE_STORAGE_KEY).toBe('bitbucket.tokenUsage');
  });

  it('shows the table even while Bitbucket is not configured, as the counts are kept on this computer', async () => {
    config = { baseUrl: undefined, authType: 'datacenter', token: undefined };
    usage = { '2026-11': { 'gpt-review': { input: 12_000, output: 3_400, calls: 5, estimated: false } } };
    const result = await callTool(tool('bitbucket_token_usage'), {}, toolDeps());
    expect(result.text).toContain('| 2026-11 | gpt-review | 12,000 | 3,400 | 5 |');
    expect(result.text).not.toContain('not configured');
  });
});

describe('with Bitbucket not configured', () => {
  const inputs: Record<string, unknown> = {
    bitbucket_check_connection: {},
    bitbucket_getPullRequest: { project: 'PROJ', repo: 'app', prId: 482 },
    bitbucket_getPullRequestDiff: { project: 'PROJ', repo: 'app', prId: 482 },
    bitbucket_postComment: { project: 'PROJ', repo: 'app', prId: 482, comment: 'Looks good.' },
    bitbucket_open_review: { url: PR_URL },
    bitbucket_read_findings: { url: PR_URL },
  };

  it('every tool that talks to Bitbucket answers the setup hint and makes no request', async () => {
    config = { baseUrl: undefined, authType: 'datacenter', token: undefined };
    const needsBitbucket = BITBUCKET_TOOLS.filter(t => t.name !== 'bitbucket_token_usage');
    expect(Object.keys(inputs).sort()).toEqual(needsBitbucket.map(t => t.name).sort());
    for (const t of needsBitbucket) {
      const result = await callTool(t, inputs[t.name], toolDeps());
      expect(result.text, t.name).toContain('Bitbucket base URL not configured. Add `ticketSidekick.bitbucket.baseUrl` in VS Code settings');
    }
    expect(client.prReads + client.userReads + client.getPullRequestDiffCalls.length + client.addPrCommentCalls.length).toBe(0);
    expect(opened).toEqual([]);
  });

  it('a Cloud setup without credentials names the Cloud setup command', async () => {
    config = { baseUrl: undefined, authType: 'cloud', token: undefined };
    const result = await callTool(tool('bitbucket_getPullRequest'), inputs.bitbucket_getPullRequest, toolDeps());
    expect(result.text).toBe('Bitbucket credentials not configured. Run "Ticket Sidekick: Configure Bitbucket Cloud Credentials" from the Command Palette.');
  });
});
