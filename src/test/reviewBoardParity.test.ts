import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { resolve } from 'path';
import { BITBUCKET_TOOLS } from '../tools/bitbucketTools/catalog';

// Guard for the review board parity ledger in docs/architecture/migration-status.md. Every behaviour of the
// `@bitbucket` chat participant (follow-up intents and reply words, chips, sessions, slash commands, modes, settings
// and the rules of docs/review-process.md) must have a row there saying whether the review board and the Bitbucket
// tools carry it over or drop it, and every row that carries over must name, in BOARD_PARITY below, the review board
// action, page request or Bitbucket tool that keeps it and the scenario test that proves the result.
// This guard outlives `@bitbucket`: the participant's behaviours are kept below as they were, and this map holds them.
// See docs/solutions/workflow-issues/import-board-parity-list-misses-recent-functional-import-work.md.

const root = process.cwd();
const read = (file: string): string => readFileSync(resolve(root, file), 'utf-8');

/** The text of the ledger section, from its heading up to the next heading of the same or a higher level. */
function ledgerSection(): string {
  const doc = read('docs/architecture/migration-status.md');
  const start = doc.indexOf('#### Review board parity ledger');
  expect(start, 'migration-status.md has a "Review board parity ledger" section').toBeGreaterThanOrEqual(0);
  const rest = doc.slice(doc.indexOf('\n', start) + 1);
  const end = rest.search(/^#{2,4} /m);
  return end === -1 ? rest : rest.slice(0, end);
}

interface LedgerRow { decision: string; note: string }

/** The ledger rows by behaviour id: each code span in the first cell of a table row. */
function ledgerRows(section: string): Map<string, LedgerRow> {
  const rows = new Map<string, LedgerRow>();
  for (const line of section.split('\n')) {
    const cells = line.split('|').map(c => c.trim());
    if (cells.length < 5 || cells[1].startsWith('---') || cells[2] === 'Board') continue;
    for (const m of cells[1].matchAll(/`([^`]+)`/g)) {
      expect(rows.has(m[1]), `${m[1]} has more than one row in the review board parity ledger`).toBe(false);
      rows.set(m[1], { decision: cells[2], note: cells[3] });
    }
  }
  return rows;
}

const DECISIONS = ['Carry over', 'Dropped'];

/** Everything `@bitbucket` did, as the participant named it before its removal. */
const CHAT_BEHAVIOURS = [
  // Follow-up intents (`parseFollowUpIntent`) and the other reply words
  'explain', 'copy', 'add', 'post it', 'refinement', 'goal', 'finding-not-found', 'diff-question', 'follow-up-failure',
  'finding-match', 'done', 'cancel', 'smart-fallback-reply',
  // Follow-up chips (`computeBitbucketFollowups`) and the clickable finding headings
  'chip-check', 'chip-copy', 'chip-add', 'chip-explain', 'chip-check-against-ticket', 'chip-post-it', 'chip-cancel', 'chip-done',
  'finding-heading-links',
  // Sessions
  'bitbucket.session.review', 'bitbucket.session.commentPreview', 'bitbucket.session.smartFallback', 'session-continuity',
  // Slash commands
  '/check', '/review', '/usage',
  // Review modes
  'standard', 'smart', 'deep', 'quick', 'mode words',
  // Settings
  'ticketSidekick.bitbucket.baseUrl', 'ticketSidekick.bitbucket.authType', 'ticketSidekick.bitbucket.reviewModel',
  'ticketSidekick.bitbucket.reviewInstructions', 'ticketSidekick.bitbucket.modelContextTokens', 'ticketSidekick.bitbucket.contextBudgetRatio',
  'ticketSidekick.bitbucket.reviewContextLines', 'ticketSidekick.bitbucket.reviewExcludePatterns', 'ticketSidekick.bitbucket.confidenceThreshold',
  'ticketSidekick.bitbucket.reviewMode', 'ticketSidekick.bitbucket.showTokenUsage',
  // Pipeline rules of docs/review-process.md
  'batches', 'dc-truncated-diffs', 'dc-response-shape', 'skipped-files', 'anchor-verification', 'reply-parsing', 'retry-and-split',
  'continuation', 'whole-file-call', 'context-files', 'persona-passes', 'dedupe', 'finding-numbers', 'critic', 'partial-results',
  'failed-review', 'upfront-question', 'ticket-choice', 'ticket-read', 'requirements-call', 'coverage-block', 'token-meter',
  'monthly-counters', 'token-footer', 'review-completed',
];

interface BoardEquivalent {
  /** Review board actions, preview types and run requests that keep the behaviour (their `type`). */
  actions?: string[];
  /** Page requests the board host answers for it (`src/boards/boardMessages.ts`). */
  requests?: string[];
  /** Bitbucket tools that keep it. */
  tools?: string[];
  /** The scenario tests that check the same result as the chat flow: file under src/test/, then the test title. */
  tests: Array<[file: string, title: string]>;
}

const BOARD = 'reviewBoard.test.ts';
const RUNS = 'reviewBoardRuns.test.ts';
const FINDINGS = 'reviewBoardFindings.test.ts';
const PAGE = 'reviewBoardPage.test.ts';
const START = 'reviewStartScreen.test.ts';
const ENGINE = 'reviewEngine.test.ts';
const TOOLS = 'bitbucketTools.test.ts';

const POST: BoardEquivalent = {
  actions: ['select', 'draft', 'post'],
  tests: [
    [FINDINGS, 'selecting a finding drafts its comment once, from the finding and its explanation'],
    [FINDINGS, 'previews each selected draft as it is, and declining the native confirmation posts nothing and keeps the drafts'],
    [FINDINGS, 'posting #2 and #5 when #5 fails reports #2 posted and #5 failed, and offers only #5 again'],
  ],
};
const CHECK_CONNECTION: BoardEquivalent = {
  tools: ['bitbucket_check_connection'],
  tests: [
    [TOOLS, 'reports the signed-in user and the settings, never the token'],
    [TOOLS, 'names a malformed Data Center base URL before trying to connect'],
    [TOOLS, 'answers a failed connection as failed, with the error'],
  ],
};
const BUDGET: BoardEquivalent = {
  actions: ['start'],
  tests: [
    [ENGINE, 'numbers the findings once, stores the reviewed commit and each batch\'s context file, and records the pass as run'],
    [ENGINE, 'stops during batch 3\'s model call: no further call, no retry or split, and batch 3 is not finished and not failed'],
  ],
};
const SKIPPED_FILES: BoardEquivalent = {
  actions: ['start'],
  tests: [[ENGINE, 'asks for the configured context lines, and leaves out excluded files and files with no text change, saying how many']],
};
const INSTRUCTIONS: BoardEquivalent = {
  actions: ['start', 'passes'],
  tests: [[ENGINE, 'gives the review instructions and the upfront question to every review call, the persona passes and the critic, and the ticket text only to the requirements check']],
};
const PERSONAS: BoardEquivalent = {
  actions: ['pick-pass', 'passes'],
  tests: [
    [RUNS, 'preselects the suggested pass and offers all four persona passes and the critic'],
    [RUNS, 'runs the picked persona passes first and the critic last, in one run, and marks them as run'],
  ],
};
const STORED_REVIEW: BoardEquivalent = {
  actions: ['new-review', 'back-to-review'],
  tools: ['bitbucket_read_findings'],
  tests: [
    [BOARD, 'opens again for PR #482; New review then Start asks before replacing it, and declining keeps it'],
    [RUNS, 'a regular pass cut off by a restart during batch 4 of 7 shows the findings of batches 1 to 3 under the interrupted banner, and the review takes extra passes'],
    [TOOLS, 'after a restart, with finding 3, returns #3\'s code from the diff and its explanation'],
  ],
};

/** Every "Carry over" row of the ledger, and what keeps it on the review board or in the tools. */
const BOARD_PARITY: Record<string, BoardEquivalent> = {
  // Follow-up intents and reply words
  explain: {
    actions: ['explain'],
    tests: [[FINDINGS, 'explaining #3 makes one model call with its code, the pull request and the upfront question, and shows the answer; explaining again replaces it']],
  },
  copy: {
    requests: ['copy'],
    tests: [
      [FINDINGS, 'Copy for Teams of #3 gives plain text with its explanation and no Markdown characters'],
      [FINDINGS, 'Copy as Markdown escapes a finding title that contains * and ['],
      [FINDINGS, 'with nothing selected, copies every finding'],
    ],
  },
  add: POST,
  'post it': {
    actions: ['post'],
    tests: [[FINDINGS, 'previews each selected draft as it is, and declining the native confirmation posts nothing and keeps the drafts']],
  },
  refinement: {
    actions: ['rewrite', 'undo-rewrite'],
    tests: [[FINDINGS, 'a successful Rewrite uses the instruction and offers Undo, which restores the previous text until the next edit']],
  },
  goal: {
    actions: ['source', 'goal', 'recheck'],
    tests: [
      [RUNS, 'switching from the ticket to a reworded goal and re-checking makes one requirements call, replaces the coverage and leaves the findings'],
      [ENGINE, 'runs exactly one model call on the stored diff and replaces only the coverage'],
    ],
  },
  'finding-not-found': {
    actions: ['explain'],
    tools: ['bitbucket_read_findings'],
    tests: [
      [FINDINGS, 'is refused for a finding that is not in the review'],
      [TOOLS, 'answers a finding number the review does not have with the numbers it has'],
    ],
  },
  'diff-question': {
    tools: ['bitbucket_read_findings', 'bitbucket_getPullRequestDiff'],
    tests: [
      [TOOLS, 'lists every finding by severity, and leaves a finding labelled probably a false alarm out of the verdict'],
      [TOOLS, 'bitbucket_getPullRequestDiff asks for the configured context lines when the call gives none'],
    ],
  },
  'follow-up-failure': {
    actions: ['explain', 'rewrite'],
    tests: [
      [FINDINGS, 'a failed explanation shows an error line under the finding and keeps the earlier answer'],
      [FINDINGS, 'a failed Rewrite leaves the hand-edited text unchanged and shows the error under the draft'],
    ],
  },

  // Sessions
  'bitbucket.session.review': STORED_REVIEW,
  'bitbucket.session.commentPreview': {
    actions: ['draft'],
    tests: [[FINDINGS, 'previews each selected draft as it is, and declining the native confirmation posts nothing and keeps the drafts']],
  },

  // Slash commands
  '/check': CHECK_CONNECTION,
  '/review': {
    actions: ['open'],
    tools: ['bitbucket_open_review'],
    tests: [
      [TOOLS, 'answers "opened" without waiting for the review: the board stops on its first step and nothing is reviewed'],
      [START, 'opens the review board for a pull request link, by its normalised address'],
    ],
  },
  '/usage': {
    tools: ['bitbucket_token_usage'],
    tests: [
      [TOOLS, 'shows the monthly per-model token table'],
      [TOOLS, 'shows the table even while Bitbucket is not configured, as the counts are kept on this computer'],
    ],
  },

  // Review modes
  standard: {
    actions: ['start'],
    tests: [[BOARD, 'runs the regular pass with the upfront question and shows the findings by severity, with the passes run and the model']],
  },
  smart: {
    actions: ['pick-pass', 'passes'],
    tests: [
      [ENGINE, 'suggests the union of the batches\' recommendations: security, then nothing, then security and performance'],
      [RUNS, 'preselects the suggested pass and offers all four persona passes and the critic'],
      [RUNS, 'when no batch gave a usable recommendation, says so and suggests nothing'],
    ],
  },
  deep: PERSONAS,

  // Settings
  'ticketSidekick.bitbucket.baseUrl': CHECK_CONNECTION,
  'ticketSidekick.bitbucket.authType': CHECK_CONNECTION,
  'ticketSidekick.bitbucket.reviewModel': {
    actions: ['pick-model'],
    tests: [
      [BOARD, 'asks for a model while the setting is empty, makes no model call before the pick, and the next review does not ask again'],
      [BOARD, 'asks for a model when the setting names one that is not available'],
    ],
  },
  'ticketSidekick.bitbucket.reviewInstructions': INSTRUCTIONS,
  'ticketSidekick.bitbucket.modelContextTokens': BUDGET,
  'ticketSidekick.bitbucket.contextBudgetRatio': BUDGET,
  'ticketSidekick.bitbucket.reviewContextLines': {
    actions: ['start'],
    tools: ['bitbucket_getPullRequestDiff'],
    tests: [
      ...SKIPPED_FILES.tests,
      [TOOLS, 'bitbucket_getPullRequestDiff asks for the configured context lines when the call gives none'],
    ],
  },
  'ticketSidekick.bitbucket.reviewExcludePatterns': {
    actions: ['start'],
    tests: [
      ...SKIPPED_FILES.tests,
      [ENGINE, 'fetches the files a Data Center server cut from the diff one by one and reviews them, and names a file still cut and one it could not fetch'],
    ],
  },
  'ticketSidekick.bitbucket.confidenceThreshold': {
    actions: ['start'],
    tests: [[BOARD, 'marks a low-confidence finding']],
  },

  // Pipeline rules
  batches: BUDGET,
  'dc-truncated-diffs': {
    actions: ['start'],
    tests: [[ENGINE, 'fetches the files a Data Center server cut from the diff one by one and reviews them, and names a file still cut and one it could not fetch']],
  },
  'dc-response-shape': {
    actions: ['start'],
    tests: [['BitbucketApiClient.test.ts', 'logs a shape summary for each Data Center response it reads']],
  },
  'skipped-files': SKIPPED_FILES,
  'anchor-verification': {
    actions: ['start'],
    tests: [[ENGINE, 'puts a finding on the line its quoted code is on, keeps one whose code is not in the diff as location unverified, and drops one naming a file outside the pull request']],
  },
  'reply-parsing': {
    actions: ['start'],
    tests: [[ENGINE, 'retries a reply with no usable JSON like a provider error, and keeps the findings of the retry']],
  },
  'retry-and-split': {
    actions: ['start'],
    tests: [
      [ENGINE, 'keeps the other batches\' findings when one batch fails after its retries, and counts it as failed'],
      ['lmRetry.test.ts', 'falls back to a single easier (split) try after the identical retry also fails'],
    ],
  },
  continuation: {
    actions: ['start'],
    tests: [[ENGINE, 'gives a reply cut off mid-finding one continuation call that lists what it already reported, and keeps the findings of both']],
  },
  'whole-file-call': {
    actions: ['start'],
    tests: [[ENGINE, 'lets the call with the whole files a batch asked for retract a first finding by its number, and keeps the others']],
  },
  'context-files': {
    actions: ['passes'],
    tests: [
      [ENGINE, 'a security pass run later re-reads the stored context file at the reviewed commit, not at a newer head'],
      [ENGINE, 'may ask for more files, which are read at the reviewed commit and kept for later passes'],
    ],
  },
  'persona-passes': PERSONAS,
  dedupe: {
    actions: ['passes'],
    tests: [[ENGINE, 'merges a critical security finding into #2 (a suggestion): #2 keeps its number and text, becomes critical, lists both sources and gains the corroboration bump']],
  },
  'finding-numbers': {
    actions: ['start', 'passes'],
    tests: [
      [ENGINE, 'numbers the findings once, stores the reviewed commit and each batch\'s context file, and records the pass as run'],
      [ENGINE, 'removes a rejected finding nobody worked on, labels a rejected one that was explained, and leaves every other number alone'],
    ],
  },
  critic: {
    actions: ['pick-pass', 'passes'],
    tests: [
      [ENGINE, 'removes a rejected finding nobody worked on, labels a rejected one that was explained, and leaves every other number alone'],
      [ENGINE, 'checks only the findings it has not checked yet'],
      [RUNS, 'the critic added the next day checks the unchecked findings; an explained or drafted finding stays labelled, the security pass stays marked'],
    ],
  },
  'partial-results': {
    actions: ['start'],
    tests: [[RUNS, 'with one batch that failed after its retries shows the findings of the others under the partial-results banner']],
  },
  'failed-review': {
    actions: ['start', 'again'],
    tests: [[RUNS, 'whose batches all failed shows the failure banner and Run again, and no picker or findings']],
  },
  'upfront-question': {
    actions: ['question', 'start'],
    tools: ['bitbucket_open_review'],
    tests: [
      [BOARD, 'runs the regular pass with the upfront question and shows the findings by severity, with the passes run and the model'],
      ...INSTRUCTIONS.tests,
      [TOOLS, 'answers "opened" without waiting for the review: the board stops on its first step and nothing is reviewed'],
    ],
  },
  'ticket-choice': {
    actions: ['source', 'ticket-key'],
    tests: [
      [BOARD, 'preselects the ticket when Jira is configured and the PR title has a key'],
      [BOARD, 'preselects the ticket the request names over the one in the title'],
      [BOARD, 'preselects none when no key is named, and with Jira not configured the ticket is unavailable with its reason'],
      [BOARD, 'with none picked, reads no ticket and shows no coverage'],
    ],
  },
  'ticket-read': {
    actions: ['start', 'recheck'],
    tests: [
      [RUNS, 'a ticket that cannot be read: the findings stand, the coverage position names the failed read, and Re-check runs only the check'],
      ['requirementsFlow.test.ts', 'turns a read that never settles into a failure the review can continue from'],
      ['requirementsSource.test.ts', 'caps many long comments within the total budget, keeps the newest, and says how many older ones were left out'],
    ],
  },
  'requirements-call': {
    actions: ['start', 'recheck'],
    tests: [
      [ENGINE, 'with a ticket reads it and checks the whole diff against it after the findings'],
      ...INSTRUCTIONS.tests,
      ['requirementsPass.test.ts', 'makes one second call with the files the model asked for, and no third'],
      [RUNS, 'a check whose model reply is unreadable says it failed and offers Re-check'],
    ],
  },
  'coverage-block': {
    actions: ['start'],
    tests: [
      [BOARD, 'reads the ticket and shows the coverage when the ticket is the source'],
      [PAGE, 'shows crafted finding and coverage text as plain text: no HTML or link becomes an element'],
    ],
  },
  'token-meter': {
    actions: ['start', 'explain', 'rewrite'],
    tests: [
      [BOARD, 'runs the regular pass with the upfront question and shows the findings by severity, with the passes run and the model'],
      [FINDINGS, 'Explain and Rewrite each count toward the monthly per-model counters, and Post makes no model call'],
      ['tokenMeter.test.ts', 'meters a frozen model and counts a frozen reply'],
    ],
  },
  'monthly-counters': {
    tools: ['bitbucket_token_usage'],
    tests: [
      ['tokenUsage.test.ts', 'deletes months older than the current month and the two before it when writing'],
      [TOOLS, 'shows the monthly per-model token table'],
    ],
  },
  'token-footer': {
    actions: ['start'],
    tests: [[RUNS, 'with no findings shows "No issues found" with the picker, the token usage and Run again']],
  },
  'review-completed': {
    actions: ['start'],
    tests: [[BOARD, 'runs the regular pass with the upfront question and shows the findings by severity, with the passes run and the model']],
  },
};

/** Code with its comments removed. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** The code of the review board's modules, without comments. */
function boardSource(): string {
  const dir = resolve(root, 'src/boards/review');
  return withoutComments(readdirSync(dir).filter(f => f.endsWith('.ts')).map(f => readFileSync(resolve(dir, f), 'utf-8')).join('\n'));
}

/** Whether a test file declares a test with this exact title. */
function declaresTest(source: string, title: string): boolean {
  const quoted = [`'${title.replace(/'/g, "\\'")}'`, `"${title}"`, `\`${title}\``];
  return quoted.some(q => source.includes(`it(${q}`));
}

describe('review board parity ledger', () => {
  const rows = ledgerRows(ledgerSection());

  it('lists every behaviour of @bitbucket', () => {
    const missing = CHAT_BEHAVIOURS.filter(id => !rows.has(id));
    expect(missing, 'behaviours with no row in the review board parity ledger').toEqual([]);
  });

  it('lists nothing that is not a behaviour of @bitbucket', () => {
    const extra = [...rows.keys()].filter(id => !CHAT_BEHAVIOURS.includes(id));
    expect(extra, 'ledger rows that are not in CHAT_BEHAVIOURS').toEqual([]);
  });

  it('gives every row a decision, and every dropped row its reason', () => {
    const undecided = [...rows].filter(([, row]) => !DECISIONS.includes(row.decision)).map(([id]) => id);
    expect(undecided, `rows whose decision is not one of ${DECISIONS.join(' / ')}`).toEqual([]);
    const unexplained = [...rows].filter(([, row]) => row.decision === 'Dropped' && !row.note).map(([id]) => id);
    expect(unexplained, '"Dropped" rows with no reason in their note').toEqual([]);
  });

  it('maps every "Carry over" row to the board or a tool, and nothing else', () => {
    const carried = [...rows].filter(([, row]) => row.decision === 'Carry over').map(([id]) => id);
    expect(carried.filter(id => !(id in BOARD_PARITY)), '"Carry over" rows with no board or tool equivalent').toEqual([]);
    const extra = Object.keys(BOARD_PARITY).filter(id => rows.get(id)?.decision !== 'Carry over');
    expect(extra, 'map entries that are not a "Carry over" row').toEqual([]);
  });

  it('names for each row a board action, page request or tool, and only ones the board and the tool catalog have', () => {
    const source = boardSource();
    const messages = withoutComments(read('src/boards/boardMessages.ts'));
    const tools = new Set(BITBUCKET_TOOLS.map(t => t.name));
    for (const [id, entry] of Object.entries(BOARD_PARITY)) {
      const named = (entry.actions?.length ?? 0) + (entry.requests?.length ?? 0) + (entry.tools?.length ?? 0);
      expect(named, `${id} names no board action, page request or tool`).toBeGreaterThan(0);
      for (const action of entry.actions ?? []) {
        expect(source.includes(`'${action}'`), `${id}: no src/boards/review module handles '${action}'`).toBe(true);
      }
      for (const request of entry.requests ?? []) {
        expect(messages.includes(`case '${request}'`), `${id}: the board host answers no '${request}' request`).toBe(true);
      }
      for (const tool of entry.tools ?? []) {
        expect(tools.has(tool), `${id}: the Bitbucket tool catalog has no ${tool}`).toBe(true);
      }
    }
  });

  it('proves each row with a scenario test that exists', () => {
    const missing: string[] = [];
    for (const [id, entry] of Object.entries(BOARD_PARITY)) {
      expect(entry.tests.length, `${id} names no scenario test`).toBeGreaterThan(0);
      for (const [file, title] of entry.tests) {
        if (!declaresTest(read(`src/test/${file}`), title)) missing.push(`${id}: ${file} has no test "${title}"`);
      }
    }
    expect(missing).toEqual([]);
  });
});
