import { describe, it, expect } from 'vitest';
import { renderReviewTable, buildJiraNotConfiguredMessage, buildChatCommandLink, neutralizeMarkdownLinks, isGreetingOrEmpty, computeJiraFollowups, withLastTicket, buildConstraintJql, type ReviewTableColumn, type JiraFollowupState } from '../participant/sessionState';
import {
  parseConstraintMatchSelection, extractProjectKeyFromJql, type ConstraintMatchOption,
  resolveNamedConstraints, formatMyFiltersList,
} from '../participant/sessionState';
import { MockJiraClient } from './mocks/MockJiraClient';
import {
  buildGuidedTransitionStatusOptions, parseGuidedTransitionStatusPick, findGuidedDirectTransition,
  parseGuidedTransitionPathPick, formatTransitionPathOption, parseGuidedTransitionResolutionPick,
  buildGuidedTransitionConfirmSummary, computeCommonTransitionStatuses,
} from '../participant/sessionState';
import type { JiraTransition } from '../jira/IJiraClient';
import type { CachedTransition, WorkflowGraph } from '../services/WorkflowService';
import {
  buildReviewPage, parseReviewPageNav, applyReviewSessionToggle, type ReviewRowBase,
} from '../participant/sessionState';
import {
  markRowsUpdatedExisting, parseBulkNewRowReply, applyBulkNewRowSet,
  buildImportOverview, buildNewGroupScreen, buildTicketedGroupScreen, buildStaleGroupScreen,
  initImportViewState, ensureImportViewState, computeImportResultGroups, emptyImportOutcomes, buildImportDoneSummary,
  parseOverviewReply, parseNewGroupReply, parseTicketedGroupReply, parseStaleGroupReply, IMPORT_COMMANDS,
  isConfirmation, isCancellation,
  type ReviewSession, type ImportReplyContext,
} from '../participant/sessionState';
import {
  buildStaleTargetOptions, formatStaleTargetOption, parseStaleTargetPick, parseStaleIssueTypePick,
  selectedStaleIssueTypes, staleTargetNeedsResolution, planStaleTransitions,
  type StaleTargetOption, type StaleTicketGroup,
} from '../participant/sessionState';
import * as nodePath from 'path';
import { parseEmlFile, type EmailImportItem } from '../utils/emlParser';
import { detectPatternBlocks, type DetectedBlock } from '../utils/emailBoilerplate';
import {
  buildPendingEmailCleanupSession, buildEmailCleanupConsent, buildEmailCleanupPreview, parseEmailCleanupReply,
  applyEmailCleanupDecision, resolveSaveTarget, describeBlockKinds, type EmailCleanupSession,
} from '../participant/sessionState';
import {
  parseStaleTicketToggle, applyStaleTicketToggle,
  type ReviewSessionStale, type TransitionBatchTicket,
} from '../participant/sessionState';

interface Widget {
  name: string;
  qty: number;
}

// U4: minimal ReviewRowBase-shaped row for the pageable-review-session tests below.
interface PageRow extends ReviewRowBase {
  id: string;
  existingTicketKey: string | null;
  included: boolean;
}

function makeFreshRows(count: number, startAt = 1): PageRow[] {
  return Array.from({ length: count }, (_, i) => ({
    id: String(startAt + i), existingTicketKey: null, included: true,
  }));
}

function makeTicketedRow(id: string, existingTicketKey: string): PageRow {
  return { id, existingTicketKey, included: false };
}

const WIDGET_COLUMNS: ReviewTableColumn<Widget>[] = [
  { header: 'Name', accessor: (w) => w.name },
  { header: 'Qty', accessor: (w) => String(w.qty) },
];

// A second, non-default column set to prove the bulk links render for any importer's columns (R5).
const WALTZ_TEST_COLUMNS: ReviewTableColumn<PageRow>[] = [
  { header: 'Component', accessor: (r) => `component-${r.id}` },
];

describe('renderReviewTable', () => {
  it('renders a header row, a separator row, and one data row per input row', () => {
    const rows: Widget[] = [
      { name: 'Bolt', qty: 3 },
      { name: 'Nut', qty: 7 },
    ];

    const result = renderReviewTable(WIDGET_COLUMNS, rows);
    const lines = result.split('\n');

    expect(lines).toEqual([
      '| Name | Qty |',
      '| --- | --- |',
      '| Bolt | 3 |',
      '| Nut | 7 |',
    ]);
  });

  it('renders header and separator only when given zero rows', () => {
    const result = renderReviewTable(WIDGET_COLUMNS, []);
    const lines = result.split('\n');

    expect(lines).toEqual([
      '| Name | Qty |',
      '| --- | --- |',
    ]);
  });

  it('follows the dash-per-column separator style (KTD4)', () => {
    const threeColumns: ReviewTableColumn<Widget>[] = [
      { header: 'Name', accessor: (w) => w.name },
      { header: 'Qty', accessor: (w) => String(w.qty) },
      { header: 'Extra', accessor: () => '' },
    ];
    const result = renderReviewTable(threeColumns, []);
    const separatorLine = result.split('\n')[1];

    expect(separatorLine).toBe('| --- | --- | --- |');
  });

  it('does not escape or strip a literal pipe or newline in cell content', () => {
    const columns: ReviewTableColumn<Widget>[] = [
      { header: 'Name', accessor: (w) => w.name },
    ];
    const rows: Widget[] = [{ name: 'a | b\nc', qty: 1 }];

    const result = renderReviewTable(columns, rows);

    expect(result).toContain('a | b\nc');
  });

  it('holds no state between calls with different column arrays', () => {
    const first = renderReviewTable(WIDGET_COLUMNS, [{ name: 'Bolt', qty: 3 }]);

    interface Other {
      label: string;
    }
    const otherColumns: ReviewTableColumn<Other>[] = [
      { header: 'Label', accessor: (o) => o.label },
    ];
    const second = renderReviewTable(otherColumns, [{ label: 'x' }]);

    expect(first).toBe('| Name | Qty |\n| --- | --- |\n| Bolt | 3 |');
    expect(second).toBe('| Label |\n| --- |\n| x |');

    // Calling again with the original columns still produces the original output — no
    // leftover state from the intervening call with a different column array.
    const firstAgain = renderReviewTable(WIDGET_COLUMNS, [{ name: 'Bolt', qty: 3 }]);
    expect(firstAgain).toBe(first);
  });
});

describe('buildJiraNotConfiguredMessage', () => {
  it('names the base URL setting when baseUrl is missing', () => {
    const message = buildJiraNotConfiguredMessage({ baseUrl: undefined, token: undefined, authType: 'datacenter' });

    expect(message).toContain('ticketSidekick.jira.baseUrl');
  });

  it('names the Data Center PAT setup command when only the token is missing', () => {
    const message = buildJiraNotConfiguredMessage({ baseUrl: 'https://jira.example.com', token: undefined, authType: 'datacenter' });

    expect(message).toContain('Ticket Sidekick: Set Jira Personal Access Token');
  });

  it('names the Cloud credentials setup command when only the token is missing (Cloud)', () => {
    const message = buildJiraNotConfiguredMessage({ baseUrl: 'https://example.atlassian.net', token: undefined, authType: 'cloud' });

    expect(message).toContain('Ticket Sidekick: Configure Jira Cloud Credentials');
  });

  it('never emits a trusted MarkdownString command link — plain text only', () => {
    const message = buildJiraNotConfiguredMessage({ baseUrl: undefined, token: undefined, authType: 'cloud' });

    expect(message).not.toContain('(command:');
  });
});

describe('buildChatCommandLink', () => {
  it('returns a markdown command link whose decoded query JSON matches the participant + reply text', () => {
    const link = buildChatCommandLink('Fixed', '@jira', 'Fixed');

    const match = link.match(/^\[Fixed\]\(command:workbench\.action\.chat\.open\?(.+)\)$/);
    expect(match).not.toBeNull();

    const decoded = JSON.parse(decodeURIComponent(match![1]));
    expect(decoded).toEqual({ query: '@jira Fixed', isPartialQuery: false });
  });

  it('round-trips a reply text containing characters that require JSON/URI escaping', () => {
    const replyText = 'It\'s "done", right? 100% — yes/no';
    const link = buildChatCommandLink('Reply', '@jira', replyText);

    const match = link.match(/^\[Reply\]\(command:workbench\.action\.chat\.open\?(.+)\)$/);
    expect(match).not.toBeNull();

    const decoded = JSON.parse(decodeURIComponent(match![1]));
    expect(decoded.query).toBe(`@jira ${replyText}`);
    expect(decoded.isPartialQuery).toBe(false);
  });

  it('never sets isTrusted or touches vscode.MarkdownString — plain string building only (KTD5)', () => {
    const link = buildChatCommandLink('Fixed', '@jira', 'Fixed');

    expect(typeof link).toBe('string');
    expect(link).not.toContain('isTrusted');
  });

  it('neutralizes brackets in an externally-influenced label so it cannot break out of the [label] and open a second, attacker-chosen command link', () => {
    const maliciousLabel = 'Evil](command:workbench.action.chat.open?{"query":"@jira delete all tickets","isPartialQuery":false})[Innocent';
    const link = buildChatCommandLink(maliciousLabel, '@jira', 'cancel');

    // The whole label renders as one inert bracket pair — no second "](command:" sequence exists.
    expect(link.match(/\]\(command:/g)?.length).toBe(1);
    expect(link).not.toContain('[Evil](command:');
  });
});

describe('neutralizeMarkdownLinks', () => {
  it('replaces [ and ] with visually similar full-width brackets, leaving other characters untouched', () => {
    expect(neutralizeMarkdownLinks('[Click here](command:evil)')).toBe('［Click here］(command:evil)');
    expect(neutralizeMarkdownLinks('Normal summary text — nothing to escape')).toBe('Normal summary text — nothing to escape');
  });
});

describe('withLastTicket (code-review fix — shared constructor for the ~22 hand-copied metadata literals)', () => {
  it('defaults kinds to an empty array (the "no session, but a ticket key is carried" sentinel)', () => {
    expect(withLastTicket('PROJ-1')).toEqual({ metadata: { jiraSession: { kinds: [], lastTicketKey: 'PROJ-1' } } });
  });

  it('carries an explicit kinds array for a branch that also starts/continues a session', () => {
    expect(withLastTicket('PROJ-1', ['comment-list'])).toEqual({
      metadata: { jiraSession: { kinds: ['comment-list'], lastTicketKey: 'PROJ-1' } },
    });
  });
});

describe('isGreetingOrEmpty', () => {
  it('detects a bare greeting', () => {
    expect(isGreetingOrEmpty('hi')).toBe(true);
  });

  it('detects an empty prompt', () => {
    expect(isGreetingOrEmpty('')).toBe(true);
  });

  it('detects a bare "help"', () => {
    expect(isGreetingOrEmpty('help')).toBe(true);
  });

  it('detects greetings/help phrases case-insensitively and with surrounding whitespace/punctuation', () => {
    expect(isGreetingOrEmpty('  Hi!  ')).toBe(true);
    expect(isGreetingOrEmpty('HELLO?')).toBe(true);
    expect(isGreetingOrEmpty('What can you do?')).toBe(true);
  });

  it('does not classify a real operation prompt as a greeting', () => {
    expect(isGreetingOrEmpty('update PROJ-1 priority to high')).toBe(false);
  });

  it('does not misclassify a prompt whose ticket key looks like a greeting word (specific-before-generic)', () => {
    // A ticket literally keyed "HI-1" must not make this prompt read as the greeting "hi" —
    // isGreetingOrEmpty only matches the whole normalized prompt, never a substring/word within it
    // (see docs/solutions/logic-errors/confirm-cancel-word-list-broadening-swallows-domain-name-collisions.md).
    expect(isGreetingOrEmpty('update HI-1 status')).toBe(false);
    expect(isGreetingOrEmpty('show me HELP-42')).toBe(false);
  });

  it('does not classify an ordinary multi-word sentence as a greeting just because it starts with a greeting word', () => {
    expect(isGreetingOrEmpty('hi there, can you show me PROJ-123 please')).toBe(false);
  });
});

describe('computeJiraFollowups', () => {
  it('returns exactly 3 chips for a greeting with no resolvable branch key, including "Show my filters"', () => {
    const chips = computeJiraFollowups({ kind: 'greeting' });

    expect(chips.length).toBe(3);
    for (const chip of chips) {
      expect(chip.prompt.length).toBeGreaterThan(0);
    }
    // R1: the comment chip is gone everywhere.
    expect(chips.some((c) => /comment/i.test(c.prompt))).toBe(false);
    // R4/AE3: never a fabricated placeholder ticket key.
    expect(chips.some((c) => c.prompt.includes('PROJ-123'))).toBe(false);
    // R2: the static "show my filters" chip.
    expect(chips.some((c) => c.prompt === 'show my filters')).toBe(true);
  });

  it('shows 4 chips for a greeting with a resolved branch key, keeping both "show me {key}" and "show my filters"', () => {
    const chips = computeJiraFollowups({ kind: 'greeting', branchKey: 'PROJ-123' });

    expect(chips.length).toBe(4);
    expect(chips.some((c) => /show me proj-123/i.test(c.prompt))).toBe(true);
    // R2: the static filters chip must never lose its slot to the branch-key chip.
    expect(chips.some((c) => c.prompt === 'show my filters')).toBe(true);
  });

  it('returns exactly 1 chip for the unclassifiable-prompt fallback with no resolvable branch key', () => {
    const chips = computeJiraFollowups({ kind: 'fallback' });

    expect(chips.length).toBe(1);
    expect(chips.some((c) => /search/i.test(c.prompt))).toBe(true);
    // R1: no comment chip.
    expect(chips.some((c) => /comment/i.test(c.prompt))).toBe(false);
  });

  it('returns 2 chips for the fallback with a resolved branch key, including "show me {key}"', () => {
    const chips = computeJiraFollowups({ kind: 'fallback', branchKey: 'PROJ-123' });

    expect(chips.length).toBe(2);
    expect(chips.some((c) => /show me proj-123/i.test(c.prompt))).toBe(true);
    expect(chips.some((c) => /comment/i.test(c.prompt))).toBe(false);
  });

  it('returns "transition it"/"create a template"/"discover workflow"-shaped chips after loading a ticket, with no comment chip', () => {
    const state: JiraFollowupState = { kind: 'loadedTicket', ticketKey: 'PROJ-123', projectKey: 'PROJ', issueType: 'Bug' };

    const chips = computeJiraFollowups(state);

    expect(chips.length).toBeLessThanOrEqual(3);
    expect(chips.some((c) => /comment/i.test(c.prompt) || /comment/i.test(c.label ?? ''))).toBe(false);
    expect(chips.some((c) => /transition/i.test(c.prompt) || /transition/i.test(c.label ?? ''))).toBe(true);
    expect(chips.some((c) => /template/i.test(c.prompt) || /template/i.test(c.label ?? ''))).toBe(true);
    expect(chips.some((c) => /discover workflow/i.test(c.prompt) || /discover workflow/i.test(c.label ?? ''))).toBe(true);
    // The prompt itself names the real ticket key/project/issue type so it works without relying
    // on pronoun resolution against chat history, and both new chips carry the state's own
    // projectKey/issueType (KTD4) rather than needing a re-fetch when clicked.
    expect(chips.find((c) => /transition/i.test(c.prompt))?.prompt).toContain('PROJ-123');
    expect(chips.find((c) => /generate a template/i.test(c.prompt))?.prompt).toContain('PROJ-123');
    expect(chips.find((c) => /discover workflow/i.test(c.prompt))?.prompt).toContain('PROJ Bug');
  });

  it('omits the "discover workflow" chip when issueType is unknown, keeping the other two', () => {
    // JiraParticipant.ts's shared post-operation tail (addComment, updateField, transition, …)
    // deliberately leaves issueType empty rather than paying for an extra getIssue call just for
    // this one chip — computeJiraFollowups must degrade to omitting it, not render a broken
    // "Discover workflow for PROJ/" chip with a blank issue type.
    const state: JiraFollowupState = { kind: 'loadedTicket', ticketKey: 'PROJ-123', projectKey: 'PROJ', issueType: '' };

    const chips = computeJiraFollowups(state);

    expect(chips.some((c) => /discover workflow/i.test(c.prompt))).toBe(false);
    expect(chips.some((c) => /transition/i.test(c.prompt))).toBe(true);
    expect(chips.some((c) => /template/i.test(c.prompt))).toBe(true);
  });

  it('omits the "create a template" chip right after generateTemplate succeeded, keeping the other two', () => {
    const state: JiraFollowupState = { kind: 'loadedTicket', ticketKey: 'PROJ-123', projectKey: 'PROJ', issueType: 'Bug', justDid: 'generateTemplate' };

    const chips = computeJiraFollowups(state);

    expect(chips.some((c) => /template/i.test(c.prompt))).toBe(false);
    expect(chips.some((c) => /transition/i.test(c.prompt))).toBe(true);
    expect(chips.some((c) => /discover workflow/i.test(c.prompt))).toBe(true);
  });

  it('omits the "discover workflow" chip right after discoverWorkflow succeeded, keeping the other two', () => {
    const state: JiraFollowupState = { kind: 'loadedTicket', ticketKey: 'PROJ-123', projectKey: 'PROJ', issueType: 'Bug', justDid: 'discoverWorkflow' };

    const chips = computeJiraFollowups(state);

    expect(chips.some((c) => /discover workflow/i.test(c.prompt))).toBe(false);
    expect(chips.some((c) => /transition/i.test(c.prompt))).toBe(true);
    expect(chips.some((c) => /template/i.test(c.prompt))).toBe(true);
  });

  it('omits only the "transition it" chip right after transition succeeded, keeping the two new chips', () => {
    const state: JiraFollowupState = { kind: 'loadedTicket', ticketKey: 'PROJ-123', projectKey: 'PROJ', issueType: 'Bug', justDid: 'transition' };

    const chips = computeJiraFollowups(state);

    expect(chips.some((c) => /transition/i.test(c.prompt))).toBe(false);
    expect(chips.some((c) => /template/i.test(c.prompt))).toBe(true);
    expect(chips.some((c) => /discover workflow/i.test(c.prompt))).toBe(true);
    expect(chips.length).toBeLessThanOrEqual(3);
  });

  it('returns no chips when there is no prior operation state', () => {
    expect(computeJiraFollowups({ kind: 'none' })).toEqual([]);
  });

  // U5/R7-R8: search/filter result refine chips.
  describe('searchResults', () => {
    it('offers both "refine to my tickets" and "refine to current sprint" when the result is single-project and a sprint is eligible', () => {
      const state: JiraFollowupState = { kind: 'searchResults', sprintName: 'Sprint 24', transitionChipEligible: false };

      const chips = computeJiraFollowups(state);

      expect(chips.some((c) => c.prompt === 'refine to my tickets')).toBe(true);
      expect(chips.some((c) => c.prompt === "refine to sprint 'Sprint 24'")).toBe(true);
      expect(chips.length).toBeLessThanOrEqual(3);
    });

    it('offers only "refine to my tickets" when the result spans multiple projects (sprint chip not eligible)', () => {
      const state: JiraFollowupState = { kind: 'searchResults', transitionChipEligible: false };

      const chips = computeJiraFollowups(state);

      expect(chips).toEqual([{ prompt: 'refine to my tickets', label: 'Refine to my tickets' }]);
    });

    it('offers only "refine to my tickets" when single-project but no sprint board is configured or no active sprint resolves', () => {
      const state: JiraFollowupState = { kind: 'searchResults', sprintName: undefined, transitionChipEligible: false };

      const chips = computeJiraFollowups(state);

      expect(chips).toEqual([{ prompt: 'refine to my tickets', label: 'Refine to my tickets' }]);
      expect(chips.some((c) => /sprint/i.test(c.prompt))).toBe(false);
    });

    it('"refine to my tickets" is always present, unconditionally, regardless of eligibility', () => {
      expect(computeJiraFollowups({ kind: 'searchResults', sprintName: 'X', transitionChipEligible: false })
        .some((c) => c.prompt === 'refine to my tickets')).toBe(true);
      expect(computeJiraFollowups({ kind: 'searchResults', transitionChipEligible: false })
        .some((c) => c.prompt === 'refine to my tickets')).toBe(true);
    });

    // U6/R9: "Transition these…" chip.
    it('offers the "Transition these…" chip when transitionChipEligible', () => {
      const state: JiraFollowupState = { kind: 'searchResults', transitionChipEligible: true };

      const chips = computeJiraFollowups(state);

      expect(chips.some((c) => c.prompt === 'transition these tickets')).toBe(true);
    });

    it('omits the "Transition these…" chip when not transitionChipEligible', () => {
      const state: JiraFollowupState = { kind: 'searchResults', transitionChipEligible: false };

      const chips = computeJiraFollowups(state);

      expect(chips.some((c) => c.prompt === 'transition these tickets')).toBe(false);
    });
  });
});

// R2/F1/U2: guided single-ticket transition flow's pure helpers. JiraParticipant.ts's
// continueGuidedTransition() (the vscode-dependent glue that stitches these into a multi-turn
// session) is only covered by the e2e suite — see sessionState.ts's own module doc comment.
describe('buildGuidedTransitionStatusOptions', () => {
  it('lists direct transition targets in order when there is no cached workflow graph', () => {
    const direct = [{ to: { name: 'In Progress' } }, { to: { name: 'Blocked' } }];

    expect(buildGuidedTransitionStatusOptions(direct, undefined, 'To Do')).toEqual(['In Progress', 'Blocked']);
  });

  it('includes AE1: a target reachable only via 2 hops, sourced from the cached graph', () => {
    const direct = [{ to: { name: 'Blocked' } }];
    const graph: WorkflowGraph = {
      'In Progress': [{ id: '1', name: 'Review', to: 'In Review' }],
      'In Review': [{ id: '2', name: 'Approve', to: 'Done' }],
    };

    const options = buildGuidedTransitionStatusOptions(direct, graph, 'In Progress');

    expect(options).toContain('Blocked');
    expect(options).toContain('Done'); // only reachable in 2 hops via the graph, not a direct target
    expect(options).toContain('In Review');
  });

  it('excludes the current status and never lists a status twice', () => {
    const direct = [{ to: { name: 'Done' } }];
    const graph: WorkflowGraph = { 'In Progress': [{ id: '1', name: 'Finish', to: 'Done' }] };

    const options = buildGuidedTransitionStatusOptions(direct, graph, 'In Progress');

    expect(options.filter((s) => s === 'Done').length).toBe(1);
    expect(options).not.toContain('In Progress');
  });
});

describe('parseGuidedTransitionStatusPick', () => {
  const options = ['In Progress', 'Blocked', 'Done'];

  it('matches by 1-based number', () => {
    expect(parseGuidedTransitionStatusPick('2', options)).toBe('Blocked');
  });

  it('matches by case-insensitive name', () => {
    expect(parseGuidedTransitionStatusPick('done', options)).toBe('Done');
  });

  it('recognizes an explicit cancellation', () => {
    expect(parseGuidedTransitionStatusPick('cancel', options)).toBe('cancel');
  });

  it('picks a status whose name is also a cancel word instead of cancelling', () => {
    const withCancelled = [...options, 'Cancelled'];
    expect(parseGuidedTransitionStatusPick('Cancelled', withCancelled)).toBe('Cancelled');
    expect(parseGuidedTransitionStatusPick('cancelled', withCancelled)).toBe('Cancelled');
    expect(parseGuidedTransitionStatusPick('cancel', withCancelled)).toBe('cancel');
  });

  it('reports an unmatched reply as invalid (KTD6) rather than guessing', () => {
    expect(parseGuidedTransitionStatusPick('Nonexistent Status', options)).toBe('invalid');
  });
});

describe('findGuidedDirectTransition', () => {
  const transitions: JiraTransition[] = [
    { id: '11', name: 'Start Progress', to: { name: 'In Progress' } },
    { id: '31', name: 'Close', to: { name: 'Done' }, fields: { resolution: { required: true, allowedValues: [{ name: 'Fixed' }] } } },
  ];

  it('finds a direct transition case-insensitively by target status name', () => {
    expect(findGuidedDirectTransition(transitions, 'done')?.id).toBe('31');
  });

  it('returns undefined when no direct transition matches', () => {
    expect(findGuidedDirectTransition(transitions, 'Blocked')).toBeUndefined();
  });
});

// U6/R9: multi-ticket transition chip's status intersection. The status-pick parser itself is
// `parseGuidedTransitionStatusPick` (reused verbatim, already covered above) — nothing new to
// test there.
describe('computeCommonTransitionStatuses', () => {
  it('returns the intersection when two tickets have overlapping transitions', () => {
    const result = computeCommonTransitionStatuses([
      ['In Progress', 'Blocked', 'Done'],
      ['Done', 'Blocked'],
    ]);

    expect(result.sort()).toEqual(['Blocked', 'Done']);
  });

  it('returns an empty array when two tickets have no common transition', () => {
    const result = computeCommonTransitionStatuses([
      ['In Progress'],
      ['Done'],
    ]);

    expect(result).toEqual([]);
  });

  it('de-duplicates a single ticket\'s own repeated transition target', () => {
    const result = computeCommonTransitionStatuses([
      ['Done', 'Done'],
      ['Done'],
    ]);

    expect(result).toEqual(['Done']);
  });

  it('returns an empty array for empty input', () => {
    expect(computeCommonTransitionStatuses([])).toEqual([]);
  });
});

describe('parseGuidedTransitionPathPick', () => {
  it('matches a valid 1-based number within range', () => {
    expect(parseGuidedTransitionPathPick('2', 3)).toBe(2);
  });

  it('rejects a number out of range as invalid', () => {
    expect(parseGuidedTransitionPathPick('4', 3)).toBe('invalid');
  });

  it('rejects non-numeric text as invalid (KTD6)', () => {
    expect(parseGuidedTransitionPathPick('the second one', 3)).toBe('invalid');
  });

  it('recognizes an explicit cancellation', () => {
    expect(parseGuidedTransitionPathPick('cancel', 3)).toBe('cancel');
  });
});

describe('formatTransitionPathOption', () => {
  it('formats a single-hop path with singular "hop"', () => {
    const path: CachedTransition[] = [{ id: '1', name: 'Finish', to: 'Done' }];
    expect(formatTransitionPathOption('In Progress', path)).toBe('In Progress → Done (1 hop)');
  });

  it('formats a multi-hop path with plural "hops", prepending currentStatus', () => {
    const path: CachedTransition[] = [
      { id: '1', name: 'Review', to: 'In Review' },
      { id: '2', name: 'Approve', to: 'Done' },
    ];
    expect(formatTransitionPathOption('In Progress', path)).toBe('In Progress → In Review → Done (2 hops)');
  });

  it('covers AE1: two equal-length paths through different intermediates render as distinct labels', () => {
    const viaQa: CachedTransition[] = [
      { id: '1', name: 'To QA', to: 'QA' },
      { id: '2', name: 'Approve', to: 'Done' },
    ];
    const viaReview: CachedTransition[] = [
      { id: '3', name: 'To Review', to: 'In Review' },
      { id: '4', name: 'Approve', to: 'Done' },
    ];

    const labelA = formatTransitionPathOption('In Progress', viaQa);
    const labelB = formatTransitionPathOption('In Progress', viaReview);

    expect(labelA).toBe('In Progress → QA → Done (2 hops)');
    expect(labelB).toBe('In Progress → In Review → Done (2 hops)');
    expect(labelA).not.toBe(labelB);
  });
});

describe('parseGuidedTransitionResolutionPick', () => {
  const options = ['Fixed', 'Won\'t Fix'];

  it('matches by number', () => {
    expect(parseGuidedTransitionResolutionPick('1', options)).toBe('Fixed');
  });

  it('matches by case-insensitive name', () => {
    expect(parseGuidedTransitionResolutionPick("won't fix", options)).toBe("Won't Fix");
  });

  it('recognizes an explicit cancellation', () => {
    expect(parseGuidedTransitionResolutionPick('cancel', options)).toBe('cancel');
  });

  it('picks a resolution whose name is also a cancel word instead of cancelling', () => {
    const withCancelled = [...options, 'Cancelled'];
    expect(parseGuidedTransitionResolutionPick('Cancelled', withCancelled)).toBe('Cancelled');
    expect(parseGuidedTransitionResolutionPick('cancel', withCancelled)).toBe('cancel');
  });

  it('treats "none" as unmatched — this ask is only shown when a resolution is required', () => {
    expect(parseGuidedTransitionResolutionPick('none', options)).toBe('invalid');
  });
});

describe('buildGuidedTransitionConfirmSummary', () => {
  it('omits the path line for a direct (single-hop) transition', () => {
    const path: CachedTransition[] = [{ id: '1', name: 'Start', to: 'In Progress' }];
    const summary = buildGuidedTransitionConfirmSummary('PROJ-1', 'In Progress', undefined, path, 'To Do');

    expect(summary).toContain('PROJ-1');
    expect(summary).toContain('In Progress');
    expect(summary).not.toContain('Path:');
    expect(summary).not.toContain('Resolution:');
  });

  it('includes both the resolution and the multi-hop path when both are present', () => {
    const path: CachedTransition[] = [
      { id: '1', name: 'Review', to: 'In Review' },
      { id: '2', name: 'Close', to: 'Done' },
    ];
    const summary = buildGuidedTransitionConfirmSummary('PROJ-1', 'Done', 'Fixed', path, 'In Progress');

    expect(summary).toContain('Path: In Progress → In Review → Done (2 hops)');
    expect(summary).toContain('Resolution: **Fixed**');
  });
});

describe('buildConstraintJql', () => {
  it('ANDs a single sprint constraint onto a base filter JQL', () => {
    const result = buildConstraintJql('filter = 12345', { sprint: 'Sprint 42' });
    expect(result).toBe('(filter = 12345) AND (Sprint = "Sprint 42")');
  });

  it('combines all three constraints in one call', () => {
    const result = buildConstraintJql('filter = 12345', {
      fixVersion: 'Release 3.2',
      sprint: 'Sprint 42',
      assignee: 'me',
    });
    expect(result).toBe(
      '(filter = 12345) AND (fixVersion = "Release 3.2" AND Sprint = "Sprint 42" AND assignee = currentUser())',
    );
  });

  it('maps a literal assignee value of "me" to currentUser()', () => {
    const result = buildConstraintJql('project = PROJ', { assignee: 'me' });
    expect(result).toBe('(project = PROJ) AND (assignee = currentUser())');
  });

  it('quotes a non-"me" assignee identifier as a literal', () => {
    const result = buildConstraintJql('project = PROJ', { assignee: 'jdoe' });
    expect(result).toBe('(project = PROJ) AND (assignee = "jdoe")');
  });

  it('returns the base JQL unchanged when no constraints are given', () => {
    const result = buildConstraintJql('filter = 12345', {});
    expect(result).toBe('filter = 12345');
  });

  it('escapes a double quote in a constraint value instead of interpolating it raw', () => {
    const result = buildConstraintJql('filter = 12345', { fixVersion: 'Release "3.2"' });
    // The raw, unescaped value would produce: fixVersion = "Release "3.2""
    // which closes the string literal after `Release ` and leaves `3.2""` as bare, injectable JQL.
    expect(result).toBe('(filter = 12345) AND (fixVersion = "Release \\"3.2\\"")');
    expect(result).not.toContain('"Release "3.2""');
  });

  it('escapes a backslash in a constraint value instead of interpolating it raw', () => {
    const result = buildConstraintJql('filter = 12345', { assignee: 'dom\\jdoe' });
    expect(result).toBe('(filter = 12345) AND (assignee = "dom\\\\jdoe")');
  });
});

describe('parseConstraintMatchSelection (U4/R11 — generic across constraint kinds)', () => {
  const fixVersionOptions: ConstraintMatchOption[] = [
    { label: 'Release 3.2', value: 'Release 3.2' },
    { label: 'Release 3.2.1', value: 'Release 3.2.1' },
  ];
  const assigneeOptions: ConstraintMatchOption[] = [
    { label: 'Jane Doe', value: 'jdoe' },
    { label: 'John Doe', value: 'jdoe2' },
  ];

  it('resolves an exact-name reply for a fixVersion ambiguity', () => {
    expect(parseConstraintMatchSelection('Release 3.2.1', fixVersionOptions)).toEqual(fixVersionOptions[1]);
  });

  it('resolves a numeric-index reply for a fixVersion ambiguity', () => {
    expect(parseConstraintMatchSelection('1', fixVersionOptions)).toEqual(fixVersionOptions[0]);
  });

  it('resolves an exact-name reply for an assignee ambiguity', () => {
    expect(parseConstraintMatchSelection('John Doe', assigneeOptions)).toEqual(assigneeOptions[1]);
  });

  it('resolves a numeric-index reply for an assignee ambiguity', () => {
    expect(parseConstraintMatchSelection('2', assigneeOptions)).toEqual(assigneeOptions[1]);
  });

  it('reports cancel on a cancellation word', () => {
    expect(parseConstraintMatchSelection('cancel', fixVersionOptions)).toBe('cancel');
  });

  it('reports invalid on an out-of-range index', () => {
    expect(parseConstraintMatchSelection('9', fixVersionOptions)).toBe('invalid');
  });

  it('reports invalid on unrecognized text', () => {
    expect(parseConstraintMatchSelection('nonsense', fixVersionOptions)).toBe('invalid');
  });
});

describe('extractProjectKeyFromJql (U4/R11 step 1)', () => {
  it('extracts a project key from a quoted project clause', () => {
    expect(extractProjectKeyFromJql('project = "PROJ" AND resolution is EMPTY')).toBe('PROJ');
  });

  it('extracts a project key from an unquoted project clause', () => {
    expect(extractProjectKeyFromJql('project = PROJ AND status = Open')).toBe('PROJ');
  });

  it('returns null when there is no project clause at all', () => {
    expect(extractProjectKeyFromJql('assignee = currentUser() AND resolution is NULL')).toBeNull();
  });

  it('returns null for a multi-project "project in (...)" clause', () => {
    expect(extractProjectKeyFromJql('project in (A, B) AND resolution is EMPTY')).toBeNull();
  });
});

describe('resolveNamedConstraints (U7 — shared by the chat flow and jira_searchByFilter)', () => {
  const baseJql = 'project = PROJ AND status = Open';

  it('resolves a single fixVersion match', async () => {
    const client = new MockJiraClient();
    client.getProject = async () => ({
      id: '1', key: 'PROJ', name: 'Sample Project', issueTypes: [],
      versions: [{ id: 'v1', name: 'Release 3.2' }, { id: 'v2', name: 'Release 4.0' }],
    });
    const result = await resolveNamedConstraints(baseJql, { fixVersion: '3.2' }, client);
    expect(result).toEqual({ kind: 'resolved', constraints: { fixVersion: 'Release 3.2' } });
  });

  it('reports ambiguous fixVersion matches without guessing, carrying the remaining named constraints forward', async () => {
    const client = new MockJiraClient();
    client.getProject = async () => ({
      id: '1', key: 'PROJ', name: 'Sample Project', issueTypes: [],
      versions: [{ id: 'v1', name: 'Release 3.2' }, { id: 'v2', name: 'Release 3.3' }],
    });
    const result = await resolveNamedConstraints(baseJql, { fixVersion: 'Release', sprint: 'Sprint 42' }, client);
    expect(result.kind).toBe('ambiguous');
    if (result.kind === 'ambiguous') {
      expect(result.constraintKind).toBe('fixVersion');
      expect(result.options.map(o => o.value)).toEqual(['Release 3.2', 'Release 3.3']);
      expect(result.remaining).toEqual({ sprint: 'Sprint 42', assignee: undefined });
      expect(result.resolvedSoFar).toEqual({});
    }
  });

  it('reports a clear not-found signal for a fixVersion with zero matches', async () => {
    const client = new MockJiraClient();
    client.getProject = async () => ({ id: '1', key: 'PROJ', name: 'Sample Project', issueTypes: [], versions: [{ id: 'v1', name: 'Release 3.2' }] });
    const result = await resolveNamedConstraints(baseJql, { fixVersion: 'nonexistent' }, client);
    expect(result).toEqual({ kind: 'notFound', message: 'No fix version matching "nonexistent" found in **PROJ**.' });
  });

  it('resolves a single sprint match (fixture has exactly one "Sprint 42")', async () => {
    const client = new MockJiraClient();
    const result = await resolveNamedConstraints(baseJql, { sprint: 'Sprint 42' }, client);
    expect(result).toEqual({ kind: 'resolved', constraints: { sprint: 'Sprint 42' } });
  });

  it('reports ambiguous sprint matches without guessing', async () => {
    const client = new MockJiraClient();
    const result = await resolveNamedConstraints(baseJql, { sprint: 'Sprint' }, client);
    expect(result.kind).toBe('ambiguous');
    if (result.kind === 'ambiguous') {
      expect(result.constraintKind).toBe('sprint');
      // fixture's findSprints() only returns active/future sprints matching "Sprint"
      expect(result.options.map(o => o.value)).toEqual(['Sprint 42', 'Sprint 43']);
      expect(result.remaining).toEqual({ assignee: undefined });
    }
  });

  it('reports a clear not-found signal for a sprint with zero matches', async () => {
    const client = new MockJiraClient();
    const result = await resolveNamedConstraints(baseJql, { sprint: 'nonexistent-xyz' }, client);
    expect(result).toEqual({ kind: 'notFound', message: 'No sprint matching "nonexistent-xyz" found in **PROJ**.' });
  });

  it('maps the "me" literal to the assignee sentinel without a user lookup', async () => {
    const client = new MockJiraClient();
    const result = await resolveNamedConstraints(baseJql, { assignee: 'me' }, client);
    expect(result).toEqual({ kind: 'resolved', constraints: { assignee: 'me' } });
  });

  it('resolves a single assignee match by name', async () => {
    const client = new MockJiraClient();
    const result = await resolveNamedConstraints(baseJql, { assignee: 'jane' }, client);
    expect(result).toEqual({ kind: 'resolved', constraints: { assignee: 'abc123' } });
  });

  it('reports "no project scope" when the base JQL does not scope to a single project', async () => {
    const client = new MockJiraClient();
    const result = await resolveNamedConstraints('assignee = currentUser()', { fixVersion: '3.2' }, client);
    expect(result.kind).toBe('noProjectScope');
  });

  it('carries alreadyResolved constraints forward into the resolved result', async () => {
    const client = new MockJiraClient();
    const result = await resolveNamedConstraints(baseJql, { assignee: 'me' }, client, { fixVersion: 'Release 3.2' });
    expect(result).toEqual({ kind: 'resolved', constraints: { fixVersion: 'Release 3.2', assignee: 'me' } });
  });
});

describe('formatMyFiltersList (U7)', () => {
  it('formats multiple filters as a list', () => {
    const text = formatMyFiltersList([{ id: '1', name: 'My open bugs', jql: 'x' }, { id: '2', name: 'Owned filter', jql: 'y' }], []);
    expect(text).toContain('My open bugs');
    expect(text).toContain('Owned filter');
    expect(text).toContain('(id: 1)');
    expect(text).toContain('(id: 2)');
  });

  it('includes a failure note when failedSources is non-empty', () => {
    const text = formatMyFiltersList([{ id: '1', name: 'My open bugs', jql: 'x' }], ['favourites']);
    expect(text).toContain('Could not fetch your favourites filter(s)');
  });

  it('reports a clear "none found" message for zero filters', () => {
    const text = formatMyFiltersList([], []);
    expect(text).toBe('No favourite or owned filters found.');
  });
});

// U4: the pageable review session's core slicing/navigation/toggle-persistence primitives.
describe('buildReviewPage (U4/R6-R8)', () => {
  it('returns everything on one page when the "new" set is at or under BATCH_LIMIT (50)', () => {
    const allRows = makeFreshRows(50);
    const result = buildReviewPage(allRows, 0);
    expect(result.rows).toHaveLength(50);
    expect(result.page).toBe(0);
    expect(result.totalPages).toBe(1);
  });

  it('splits a "new" set larger than BATCH_LIMIT into multiple pages of up to 50 rows each', () => {
    const allRows = makeFreshRows(120);
    const first = buildReviewPage(allRows, 0);
    expect(first.rows).toHaveLength(50);
    expect(first.rows.map(r => r.id)).toEqual(Array.from({ length: 50 }, (_, i) => String(i + 1)));
    expect(first.totalPages).toBe(3);

    const second = buildReviewPage(allRows, 1);
    expect(second.rows).toHaveLength(50);
    expect(second.rows[0].id).toBe('51');

    const third = buildReviewPage(allRows, 2);
    expect(third.rows).toHaveLength(20); // remainder
    expect(third.rows[0].id).toBe('101');
  });

  it('always shows every "already ticketed" row in full, on every page, never counted toward paging', () => {
    const allRows = [makeTicketedRow('A1', 'PROJ-1'), ...makeFreshRows(60), makeTicketedRow('A2', 'PROJ-2')];
    const first = buildReviewPage(allRows, 0);
    const second = buildReviewPage(allRows, 1);
    expect(first.rows.filter(r => r.existingTicketKey !== null).map(r => r.id)).toEqual(['A1', 'A2']);
    expect(second.rows.filter(r => r.existingTicketKey !== null).map(r => r.id)).toEqual(['A1', 'A2']);
    expect(first.totalPages).toBe(2); // 60 "new" rows -> 2 pages, unaffected by the 2 ticketed rows
  });

  it('clamps a negative page request up to page 0', () => {
    const result = buildReviewPage(makeFreshRows(120), -5);
    expect(result.page).toBe(0);
  });

  it('clamps an out-of-range page request down to the last valid page', () => {
    const result = buildReviewPage(makeFreshRows(120), 99);
    expect(result.page).toBe(2); // 3 pages total, 0-based last is 2
    expect(result.rows).toHaveLength(20);
  });

  it('reports exactly one page (never zero) when there are no "new" rows at all', () => {
    const result = buildReviewPage([makeTicketedRow('A1', 'PROJ-1')], 0);
    expect(result.totalPages).toBe(1);
    expect(result.rows).toEqual([makeTicketedRow('A1', 'PROJ-1')]);
  });
});

describe('parseReviewPageNav (U4/R6)', () => {
  it('recognizes "next" and "prev"', () => {
    expect(parseReviewPageNav('next')).toEqual({ kind: 'next' });
    expect(parseReviewPageNav('prev')).toEqual({ kind: 'prev' });
  });

  it('recognizes case-insensitively and trims surrounding whitespace', () => {
    expect(parseReviewPageNav('  NEXT  ')).toEqual({ kind: 'next' });
    expect(parseReviewPageNav('Prev')).toEqual({ kind: 'prev' });
  });

  it('recognizes the "next page"/"prev page"/"previous"/"previous page" variants', () => {
    expect(parseReviewPageNav('next page')).toEqual({ kind: 'next' });
    expect(parseReviewPageNav('prev page')).toEqual({ kind: 'prev' });
    expect(parseReviewPageNav('previous')).toEqual({ kind: 'prev' });
    expect(parseReviewPageNav('previous page')).toEqual({ kind: 'prev' });
  });

  it('recognizes "page <n>", converting the 1-based typed number to a 0-based page index', () => {
    expect(parseReviewPageNav('page 3')).toEqual({ kind: 'goto', page: 2 });
    expect(parseReviewPageNav('PAGE 1')).toEqual({ kind: 'goto', page: 0 });
    expect(parseReviewPageNav('page   7')).toEqual({ kind: 'goto', page: 6 }); // collapses extra whitespace
  });

  it('returns null for anything else, including a bare row-id number and ordinary toggle/confirm replies', () => {
    expect(parseReviewPageNav('2')).toBeNull();
    expect(parseReviewPageNav('A1')).toBeNull();
    expect(parseReviewPageNav('post it')).toBeNull();
    expect(parseReviewPageNav('cancel')).toBeNull();
    expect(parseReviewPageNav('pages')).toBeNull();
    expect(parseReviewPageNav('page')).toBeNull();
    expect(parseReviewPageNav('')).toBeNull();
  });
});

describe('applyReviewSessionToggle (U4/R7-R8)', () => {
  it('toggles the given ids on the visible page rows, same as applyReviewToggle', () => {
    const rows = makeFreshRows(3); // ids '1'..'3', all included
    const result = applyReviewSessionToggle(rows, rows, ['2']);
    expect(result.rows.find(r => r.id === '2')!.included).toBe(false);
    expect(result.rows.find(r => r.id === '1')!.included).toBe(true);
  });

  it('mirrors an "already ticketed" row\'s toggle into allRows so it survives a page-navigation recompute', () => {
    const ticketed = makeTicketedRow('A1', 'PROJ-1');
    const allRows = [ticketed, ...makeFreshRows(60)];
    const page0 = buildReviewPage(allRows, 0);

    const toggled = applyReviewSessionToggle(page0.rows, allRows, ['A1']);
    expect(toggled.rows.find(r => r.id === 'A1')!.included).toBe(true);
    expect(toggled.allRows.find(r => r.id === 'A1')!.included).toBe(true);

    // Navigate away and back — buildReviewPage re-derives `rows` from the updated allRows, so the
    // ticketed-row toggle must still be visible (R8: "already ticketed" is shown in full, unaffected).
    const page1 = buildReviewPage(toggled.allRows, 1);
    const backToPage0 = buildReviewPage(toggled.allRows, 0);
    expect(page1.rows.find(r => r.id === 'A1')!.included).toBe(true);
    expect(backToPage0.rows.find(r => r.id === 'A1')!.included).toBe(true);
  });

  it('does NOT mirror a "new" row\'s toggle into allRows — a page revisited later resets to default-included (R7)', () => {
    const allRows = makeFreshRows(60);
    const page0 = buildReviewPage(allRows, 0);

    const toggled = applyReviewSessionToggle(page0.rows, allRows, ['3']); // exclude row '3' on page 0
    expect(toggled.rows.find(r => r.id === '3')!.included).toBe(false); // visible immediately
    expect(toggled.allRows.find(r => r.id === '3')!.included).toBe(true); // NOT written back

    // Page away and back to page 0 — the toggle is gone, row '3' is included again (page-local reset).
    const backToPage0 = buildReviewPage(toggled.allRows, 0);
    expect(backToPage0.rows.find(r => r.id === '3')!.included).toBe(true);
  });

  it('leaves rows not mentioned in ids untouched', () => {
    const rows = makeFreshRows(3);
    const result = applyReviewSessionToggle(rows, rows, ['2']);
    expect(result.rows.find(r => r.id === '1')!.included).toBe(true);
    expect(result.rows.find(r => r.id === '3')!.included).toBe(true);
  });
});

// U3: per-row "synced" bookkeeping for "update tickets" (R13).

describe('markRowsUpdatedExisting (U3/R13)', () => {
  it('sets updatedExisting on every row (in both rows and allRows) whose ticket key is in the update set', () => {
    const ticketed = makeTicketedRow('A1', 'PROJ-1');
    const allRows = [ticketed, ...makeFreshRows(3)];
    const result = markRowsUpdatedExisting(allRows, allRows, new Set(['PROJ-1']));

    expect(result.rows.find(r => r.id === 'A1')!.updatedExisting).toBe(true);
    expect(result.allRows.find(r => r.id === 'A1')!.updatedExisting).toBe(true);
  });

  it('leaves every other row untouched, including a "new" row with no existingTicketKey', () => {
    const ticketed = makeTicketedRow('A1', 'PROJ-1');
    const rows = [ticketed, ...makeFreshRows(2)];
    const result = markRowsUpdatedExisting(rows, rows, new Set(['PROJ-1']));

    expect(result.rows.find(r => r.id === '1')!.updatedExisting).toBeUndefined();
    expect(result.rows.find(r => r.id === '2')!.updatedExisting).toBeUndefined();
  });

  it('is a no-op when the update set is empty', () => {
    const ticketed = makeTicketedRow('A1', 'PROJ-1');
    const rows = [ticketed];
    const result = markRowsUpdatedExisting(rows, rows, new Set());
    expect(result.rows[0].updatedExisting).toBeUndefined();
  });
});

describe('parseBulkNewRowReply (review-table toggle-all)', () => {
  it('recognizes "include all" case-insensitively, trimmed', () => {
    expect(parseBulkNewRowReply('include all')).toBe(true);
    expect(parseBulkNewRowReply('INCLUDE ALL')).toBe(true);
    expect(parseBulkNewRowReply('  include all  ')).toBe(true);
  });

  it('recognizes "exclude all" case-insensitively, trimmed', () => {
    expect(parseBulkNewRowReply('exclude all')).toBe(false);
    expect(parseBulkNewRowReply('EXCLUDE ALL')).toBe(false);
    expect(parseBulkNewRowReply('  Exclude All  ')).toBe(false);
  });

  it('returns null for every existing reply vocabulary (no false positives)', () => {
    expect(parseBulkNewRowReply('2 4')).toBeNull(); // row-id toggle list
    expect(parseBulkNewRowReply('A1')).toBeNull(); // already-ticketed row id
    expect(parseBulkNewRowReply('next')).toBeNull(); // page-nav
    expect(parseBulkNewRowReply('prev')).toBeNull();
    expect(parseBulkNewRowReply('page 2')).toBeNull();
    expect(parseBulkNewRowReply('post it')).toBeNull(); // confirmation
    expect(parseBulkNewRowReply('cancel')).toBeNull(); // cancellation
    expect(parseBulkNewRowReply('PROJ-123')).toBeNull(); // stale-ticket key
    expect(parseBulkNewRowReply('update existing tickets')).toBeNull();
  });

  it('returns null for partial or extended phrases', () => {
    expect(parseBulkNewRowReply('include')).toBeNull();
    expect(parseBulkNewRowReply('all')).toBeNull();
    expect(parseBulkNewRowReply('exclude')).toBeNull();
    expect(parseBulkNewRowReply('include all rows')).toBeNull();
    expect(parseBulkNewRowReply('please exclude all now')).toBeNull();
    expect(parseBulkNewRowReply('')).toBeNull();
  });
});

describe('applyBulkNewRowSet (review-table toggle-all)', () => {
  it('sets included: true on every New row and leaves already-ticketed rows unchanged', () => {
    const ticketed = { ...makeTicketedRow('A1', 'PROJ-1'), included: true }; // re-create, must stay
    const rows = [ticketed, ...makeFreshRows(3).map(r => ({ ...r, included: false }))];
    const result = applyBulkNewRowSet(rows, true);

    expect(result.filter(r => r.existingTicketKey === null).every(r => r.included)).toBe(true);
    expect(result.find(r => r.id === 'A1')!.included).toBe(true); // untouched
  });

  it('sets included: false on every New row and leaves already-ticketed rows unchanged (AE2)', () => {
    const ticketed = makeTicketedRow('A1', 'PROJ-1'); // excluded, must stay excluded
    const rows = [ticketed, ...makeFreshRows(3)]; // all included by default
    const result = applyBulkNewRowSet(rows, false);

    expect(result.filter(r => r.existingTicketKey === null).every(r => !r.included)).toBe(true);
    expect(result.find(r => r.id === 'A1')!.included).toBe(false); // untouched
  });

  it('does not mutate the input array', () => {
    const rows = makeFreshRows(2);
    applyBulkNewRowSet(rows, false);
    expect(rows.every(r => r.included)).toBe(true);
  });

  it('is a no-op on a page with zero New rows (only already-ticketed rows, all untouched)', () => {
    const ticketed = makeTicketedRow('A1', 'PROJ-1');
    const result = applyBulkNewRowSet([ticketed], true);
    expect(result).toEqual([ticketed]);
  });
});

function screenSession(allRows: PageRow[], extra: Partial<ReviewSession<PageRow>> = {}): ReviewSession<PageRow> {
  const page = buildReviewPage(allRows, 0);
  return initImportViewState({
    projectKey: 'PROJ', issueType: 'Bug', templateName: null, additionalFields: {},
    allRows, rows: page.rows, page: page.page, schemaVersion: 6, ...extra,
  });
}

const itemOpts = { itemNoun: 'item(s)', supportsUpdateExisting: false };

describe('New screen — "Include all" / "Exclude all" links (review-table toggle-all)', () => {
  it('renders both bulk links when New rows exist, each resubmitting its exact token', () => {
    const text = buildNewGroupScreen(screenSession([makeTicketedRow('A1', 'PROJ-1'), ...makeFreshRows(2)]), [], itemOpts);

    expect(text).toContain('Include all');
    expect(text).toContain('Exclude all');
    // The link's command payload carries the exact reply token the handler parses.
    expect(decodeURIComponent(text)).toContain('"@jira include all"');
    expect(decodeURIComponent(text)).toContain('"@jira exclude all"');
  });

  it('renders neither bulk link, and says so, when every new row has been created', () => {
    const text = buildNewGroupScreen(screenSession([makeTicketedRow('A1', 'PROJ-1')]), [], itemOpts);

    expect(text).not.toContain('Include all');
    expect(text).toContain('_No new items left to create._');
  });

  it('renders the bulk links for the Waltz column set too (shared renderer — R5)', () => {
    const text = buildNewGroupScreen(screenSession(makeFreshRows(2)), WALTZ_TEST_COLUMNS, { ...itemOpts, itemNoun: 'component(s)' });

    expect(text).toContain('Include all');
    expect(text).toContain('Exclude all');
  });

  it('counts only the rows still included on the visible page in "Create N tickets"', () => {
    const session = screenSession(makeFreshRows(3));
    session.rows = session.rows.map(r => (r.id === '2' ? { ...r, included: false } : r));
    const text = buildNewGroupScreen(session, [], itemOpts);
    expect(text).toContain('**2** ticket(s) will be created.');
    expect(decodeURIComponent(text)).toContain('[Create 2 tickets]');
  });
});

describe('Already-ticketed screen — "Updated?" column and actions (U3/R13, R8, R16)', () => {
  it('omits the "Updated?" column and the update action when the importer does not support it (Waltz)', () => {
    const rows = [{ ...makeTicketedRow('A1', 'PROJ-1'), hasUnsyncedFindings: true }, ...makeFreshRows(1)];
    const text = buildTicketedGroupScreen(screenSession(rows), [], itemOpts);
    expect(text).not.toContain('Updated?');
    expect(text).not.toContain('update tickets');
  });

  it('offers "Update N tickets" counting only rows with a finding their ticket lacks', () => {
    const rows = [
      { ...makeTicketedRow('A1', 'PROJ-1'), hasUnsyncedFindings: true },
      { ...makeTicketedRow('A2', 'PROJ-2'), hasUnsyncedFindings: true },
      makeTicketedRow('A3', 'PROJ-3'),
    ];
    const text = buildTicketedGroupScreen(screenSession(rows), [], { ...itemOpts, supportsUpdateExisting: true });
    expect(text).toContain('Updated?');
    expect(decodeURIComponent(text)).toContain('[Update 2 tickets]');
    expect(decodeURIComponent(text)).toContain('"@jira update tickets"');
  });

  it('says every row is up to date instead of offering "Update 0 tickets"', () => {
    const text = buildTicketedGroupScreen(screenSession([makeTicketedRow('A1', 'PROJ-1')]), [], { ...itemOpts, supportsUpdateExisting: true });
    expect(text).not.toContain('"@jira update tickets"');
    expect(text).toContain('up to date');
  });

  it('renders "✓ synced" only for a row whose updatedExisting flag is set', () => {
    const rows = [{ ...makeTicketedRow('A1', 'PROJ-1'), updatedExisting: true }, makeTicketedRow('A2', 'PROJ-2')];
    const text = buildTicketedGroupScreen(screenSession(rows), [], { ...itemOpts, supportsUpdateExisting: true });
    const lines = text.split('\n');
    expect(lines.find(l => l.includes('PROJ-1'))!).toContain('✓ synced');
    expect(lines.find(l => l.includes('PROJ-2'))!).not.toContain('✓ synced');
  });

  it('shows "Re-create 0" until a row is toggled on, then "Re-create 1"; a re-created row shows its new key and no toggle', () => {
    const rows = [makeTicketedRow('A1', 'PROJ-1'), makeTicketedRow('A2', 'PROJ-2')];
    expect(buildTicketedGroupScreen(screenSession(rows), [], itemOpts)).toContain('Re-create 0 tickets');

    const toggled = [{ ...rows[0], included: true }, { ...rows[1], recreatedKey: 'PROJ-77', included: false }];
    const text = buildTicketedGroupScreen(screenSession(toggled), [], itemOpts);
    expect(decodeURIComponent(text)).toContain('[Re-create 1 tickets]');
    const a2Line = text.split('\n').find(l => l.includes('PROJ-2'))!;
    expect(a2Line).toContain('re-created as PROJ-77');
    expect(decodeURIComponent(a2Line)).not.toContain('"@jira A2"');
  });
});

describe('Overview screen (R1, R2, R3, R15)', () => {
  const staleWithTicket: ReviewSessionStale = {
    groups: [{ issueType: 'Bug', rules: [], graph: {}, tickets: [{
      key: 'SEC-7', summary: 's', currentStatus: 'Open', transitionPath: [], subtasks: [], included: false,
    }] }],
    ineligible: [],
    resolutionOptions: [],
  };

  it('lists New, Already ticketed and Stale with counts, open links and a Done link — and no "Post it"', () => {
    const session = screenSession([makeTicketedRow('A1', 'PROJ-1'), ...makeFreshRows(12)], { staleTickets: staleWithTicket });
    const text = buildImportOverview(session, itemOpts);
    expect(text).toContain('**New** — 12 items');
    expect(text).toContain('**Already ticketed** — 1 item');
    expect(text).toContain('**Stale tickets**');
    expect(decodeURIComponent(text)).toContain('"@jira open new"');
    expect(decodeURIComponent(text)).toContain('"@jira open already ticketed"');
    expect(decodeURIComponent(text)).toContain('"@jira open stale"');
    expect(decodeURIComponent(text)).toContain('"@jira done"');
    expect(text.toLowerCase()).not.toContain('post it');
  });

  it('shows progress after a partial create ("50 created · 12 left")', () => {
    const session = screenSession([makeTicketedRow('A1', 'PROJ-1'), ...makeFreshRows(12)]);
    session.outcomes = { ...session.outcomes!, created: 50 };
    expect(buildImportOverview(session, itemOpts)).toContain('50 created · 12 left');
  });

  it('omits a group that had no rows when the import was built', () => {
    const text = buildImportOverview(screenSession([makeTicketedRow('A1', 'PROJ-1'), ...makeFreshRows(2)]), itemOpts);
    expect(text).not.toContain('Stale');
  });

  it('keeps New listed with its outcome and no open link once every new row is created', () => {
    const session = screenSession([makeTicketedRow('A1', 'PROJ-1'), ...makeFreshRows(12)]);
    session.allRows = session.allRows.filter(r => r.existingTicketKey !== null);
    session.rows = session.allRows;
    session.outcomes = { ...session.outcomes!, created: 12 };
    const text = buildImportOverview(session, itemOpts);
    expect(text).toContain('**New** — 12 created · 0 left');
    expect(decodeURIComponent(text)).not.toContain('"@jira open new"');
  });
});

describe('Import view state (KTD1, KTD7)', () => {
  const staleOnlyIneligible: ReviewSessionStale = {
    groups: [], ineligible: [{ key: 'PROJ-9', summary: 'x', currentStatus: 'Open', note: 'no rule' }],
  };

  it('New only → a single group that opens directly on the New screen', () => {
    const s = screenSession(makeFreshRows(3));
    expect(s.groups).toEqual(['new']);
    expect(s.singleGroup).toBe(true);
    expect(s.view).toBe('new');
  });

  it('New + Stale → the overview comes first', () => {
    const s = screenSession(makeFreshRows(1), { staleTickets: staleOnlyIneligible });
    expect(s.groups).toEqual(['new', 'stale']);
    expect(s.singleGroup).toBe(false);
    expect(s.view).toBe('overview');
  });

  it('Already ticketed only → opens directly on that screen', () => {
    const s = screenSession([makeTicketedRow('A1', 'PROJ-1')]);
    expect(s.view).toBe('ticketed');
    expect(s.singleGroup).toBe(true);
  });

  it('a Stale group with only tickets lacking a cleanup rule still counts as a group', () => {
    expect(computeImportResultGroups([], staleOnlyIneligible)).toEqual(['stale']);
  });

  it('ensureImportViewState fills in a caller-built session without overwriting an explicit view', () => {
    const bare: ReviewSession<PageRow> = {
      projectKey: 'PROJ', issueType: 'Bug', templateName: null, additionalFields: {},
      allRows: makeFreshRows(1), rows: makeFreshRows(1), page: 0, schemaVersion: 6, view: 'overview',
    };
    const filled = ensureImportViewState(bare);
    expect(filled.view).toBe('overview');
    expect(filled.singleGroup).toBe(true);
    expect(filled.outcomes).toEqual(emptyImportOutcomes());
  });

  it('buildImportDoneSummary reports every outcome and any failures', () => {
    expect(buildImportDoneSummary({ ...emptyImportOutcomes(), created: 3, closed: 1, createFailed: 1 }))
      .toBe('Import finished — **3** created, 0 re-created, 0 updated, 1 closed, 1 failed.');
  });
});

describe('Per-screen reply parsing (KTD2, R6)', () => {
  const stale: ReviewSessionStale = {
    groups: [{ issueType: 'Bug', rules: [], graph: {}, tickets: [{
      key: 'SEC-7', summary: 's', currentStatus: 'Open', transitionPath: [], subtasks: [], included: false,
    }] }],
    ineligible: [],
    resolutionOptions: [],
  };
  const ctx: ImportReplyContext = {
    singleGroup: false, groups: ['new', 'ticketed', 'stale'],
    newRowIds: ['1', '2', '3'], ticketedRowIds: ['A1', 'A2'], stale, supportsUpdateExisting: true,
  };

  it('overview: open links, done, cancellation, and nothing else', () => {
    expect(parseOverviewReply('open stale', ctx)).toEqual({ kind: 'open', view: 'stale' });
    expect(parseOverviewReply('Open Already  Ticketed', ctx)).toEqual({ kind: 'open', view: 'ticketed' });
    expect(parseOverviewReply('DONE', ctx)).toEqual({ kind: 'done' });
    expect(parseOverviewReply('cancel', ctx)).toEqual({ kind: 'done' });
    expect(parseOverviewReply('3', ctx)).toEqual({ kind: 'invalid' });
    expect(parseOverviewReply('post it', ctx)).toEqual({ kind: 'invalid' });
    expect(parseOverviewReply('open stale', { ...ctx, groups: ['new'] })).toEqual({ kind: 'invalid' });
  });

  it('New: confirmation words create; row ids, bulk and page words work; other screens\' tokens do not (AE2)', () => {
    expect(parseNewGroupReply('ok', ctx)).toEqual({ kind: 'create' });
    expect(parseNewGroupReply('post it', ctx)).toEqual({ kind: 'create' });
    expect(parseNewGroupReply('create tickets', ctx)).toEqual({ kind: 'create' });
    expect(parseNewGroupReply('2 3', ctx)).toEqual({ kind: 'toggleRows', ids: ['2', '3'] });
    expect(parseNewGroupReply('next', ctx)).toEqual({ kind: 'pageNav', nav: { kind: 'next' } });
    expect(parseNewGroupReply('exclude all', ctx)).toEqual({ kind: 'bulk', include: false });
    expect(parseNewGroupReply('A1', ctx)).toEqual({ kind: 'invalid' });
    expect(parseNewGroupReply('SEC-7', ctx)).toEqual({ kind: 'invalid' });
    expect(parseNewGroupReply('2 A1', ctx)).toEqual({ kind: 'invalid' }); // never half-applied
    expect(parseNewGroupReply('back', ctx)).toEqual({ kind: 'back' });
    expect(parseNewGroupReply('skip', ctx)).toEqual({ kind: 'back' }); // a cancellation word
  });

  it('New under a single group: back/cancel/done all end the import', () => {
    const single = { ...ctx, singleGroup: true };
    expect(parseNewGroupReply('done', single)).toEqual({ kind: 'done' });
    expect(parseNewGroupReply('cancel', single)).toEqual({ kind: 'done' });
  });

  it('Already ticketed: update / re-create / A-ids; confirmation words are rejected (two actions)', () => {
    expect(parseTicketedGroupReply('A1', ctx)).toEqual({ kind: 'toggleRows', ids: ['A1'] });
    expect(parseTicketedGroupReply('update tickets', ctx)).toEqual({ kind: 'update' });
    expect(parseTicketedGroupReply('update existing tickets', ctx)).toEqual({ kind: 'update' });
    expect(parseTicketedGroupReply('re-create tickets', ctx)).toEqual({ kind: 'recreate' });
    expect(parseTicketedGroupReply('ok', ctx)).toEqual({ kind: 'invalid' });
    expect(parseTicketedGroupReply('3', ctx)).toEqual({ kind: 'invalid' });
    expect(parseTicketedGroupReply('update tickets', { ...ctx, supportsUpdateExisting: false })).toEqual({ kind: 'invalid' });
  });

  it('Stale: ticket keys toggle, confirmation words close, row ids are rejected', () => {
    expect(parseStaleGroupReply('SEC-7', ctx)).toEqual({ kind: 'toggleStale', keys: ['SEC-7'] });
    expect(parseStaleGroupReply('ok', ctx)).toEqual({ kind: 'close' });
    expect(parseStaleGroupReply('close tickets', ctx)).toEqual({ kind: 'close' });
    expect(parseStaleGroupReply('A1', ctx)).toEqual({ kind: 'invalid' });
    expect(parseStaleGroupReply('SEC-7 3', ctx)).toEqual({ kind: 'invalid' }); // mixed reply rejected whole
  });

  it('a closed stale ticket can no longer be toggled', () => {
    expect(parseStaleGroupReply('SEC-7', { ...ctx, stale: { ...stale, closedKeys: ['SEC-7'] } })).toEqual({ kind: 'invalid' });
  });

  it('no command word is a confirmation/cancellation word, a row id, or a ticket key', () => {
    for (const word of Object.values(IMPORT_COMMANDS)) {
      expect(isConfirmation(word)).toBe(false);
      expect(isCancellation(word)).toBe(false);
      expect(/^\d+$|^a\d+$/i.test(word)).toBe(false);
      expect(/^[A-Z][A-Z0-9]+-\d+$/i.test(word)).toBe(false);
      expect(parseReviewPageNav(word)).toBeNull();
      expect(parseBulkNewRowReply(word)).toBeNull();
    }
  });
});

// U6: Stale review section — toggle-reply parsing/application and the rendered table.
describe('Stale-ticket review section (U6)', () => {
  const dummyPath = [{ id: '1', name: 'Go', to: 'Done' }];

  function makeStaleTicket(key: string, included = false): TransitionBatchTicket {
    return {
      key, summary: `Summary for ${key}`, currentStatus: 'Open',
      transitionPath: dummyPath, subtasks: [], included,
    };
  }

  function makeStale(overrides: Partial<ReviewSessionStale> = {}): ReviewSessionStale {
    return {
      groups: [{ issueType: 'Bug', rules: [], graph: {}, tickets: [makeStaleTicket('PROJ-1')] }],
      ineligible: [],
      resolutionOptions: [],
      ...overrides,
    };
  }

  describe('parseStaleTicketToggle', () => {
    it('recognizes a full ticket-key reply naming an eligible stale ticket', () => {
      expect(parseStaleTicketToggle('PROJ-1', makeStale())).toEqual({ matched: ['PROJ-1'], remainder: '' });
    });

    it('is case-insensitive but returns the ticket\'s real-cased key', () => {
      expect(parseStaleTicketToggle('proj-1', makeStale())).toEqual({ matched: ['PROJ-1'], remainder: '' });
    });

    it('matches multiple ticket keys in one reply', () => {
      const stale = makeStale({
        groups: [{ issueType: 'Bug', rules: [], graph: {}, tickets: [makeStaleTicket('PROJ-1'), makeStaleTicket('PROJ-2')] }],
      });
      expect(parseStaleTicketToggle('PROJ-1 PROJ-2', stale)).toEqual({ matched: ['PROJ-1', 'PROJ-2'], remainder: '' });
    });

    // Code-review fix regression test: a reply mixing a stale-ticket-key token with other tokens
    // (row-id toggles, `post it`, ...) must preserve those other tokens in `remainder` rather than
    // silently discarding them — the caller re-parses `remainder` instead of returning immediately.
    it('preserves non-stale-key tokens as remainder for a mixed reply', () => {
      expect(parseStaleTicketToggle('PROJ-1 3 7', makeStale())).toEqual({ matched: ['PROJ-1'], remainder: '3 7' });
    });

    it('never matches a row-id token (bare numeric "2" or already-ticketed "A1") — disjoint vocabulary', () => {
      expect(parseStaleTicketToggle('2', makeStale())).toBeNull();
      expect(parseStaleTicketToggle('A1', makeStale())).toBeNull();
    });

    it('never matches U4\'s page-nav tokens', () => {
      expect(parseStaleTicketToggle('next', makeStale())).toBeNull();
      expect(parseStaleTicketToggle('prev', makeStale())).toBeNull();
      expect(parseStaleTicketToggle('page 2', makeStale())).toBeNull();
    });

    it('never matches an ineligible ticket\'s key — R4: not offered a toggle', () => {
      const stale = makeStale({
        groups: [],
        ineligible: [{ key: 'PROJ-9', summary: 'x', currentStatus: 'Open', note: 'no cleanup rule configured' }],
      });
      expect(parseStaleTicketToggle('PROJ-9', stale)).toBeNull();
    });

    it('returns null for an unrelated reply', () => {
      expect(parseStaleTicketToggle('post it', makeStale())).toBeNull();
      expect(parseStaleTicketToggle('cancel', makeStale())).toBeNull();
    });
  });

  describe('applyStaleTicketToggle', () => {
    it('flips included for the named ticket across groups', () => {
      const stale = makeStale();
      const toggled = applyStaleTicketToggle(stale, ['PROJ-1']);
      expect(toggled.groups[0].tickets[0].included).toBe(true);
      // Original untouched (pure).
      expect(stale.groups[0].tickets[0].included).toBe(false);
    });

    it('leaves tickets not named untouched', () => {
      const stale = makeStale({
        groups: [{ issueType: 'Bug', rules: [], graph: {}, tickets: [makeStaleTicket('PROJ-1'), makeStaleTicket('PROJ-2', true)] }],
      });
      const toggled = applyStaleTicketToggle(stale, ['PROJ-1']);
      expect(toggled.groups[0].tickets[0].included).toBe(true);
      expect(toggled.groups[0].tickets[1].included).toBe(true); // was already true, untouched
    });
  });

  describe('buildStaleGroupScreen', () => {
    function staleSession(stale: ReviewSessionStale): ReviewSession<ReviewRowBase> {
      return initImportViewState({
        projectKey: 'PROJ', issueType: 'Bug', templateName: null, additionalFields: {},
        allRows: [], rows: [], page: 0, schemaVersion: 6, staleTickets: stale,
      });
    }

    it('renders eligible tickets with a positive toggle link and the ineligible note for others', () => {
      const stale = makeStale({
        ineligible: [{ key: 'PROJ-9', summary: 'Old finding', currentStatus: 'Open', note: 'no cleanup rule configured for PROJ/Task' }],
      });
      const rendered = buildStaleGroupScreen(staleSession(stale), { itemNoun: 'item(s)', supportsUpdateExisting: false });
      expect(rendered).toContain('PROJ-1');
      expect(rendered).toContain('PROJ-9');
      expect(rendered).toContain('no cleanup rule configured for PROJ/Task');
      expect(rendered).toContain('Stale');
      expect(rendered).toContain('Close 0 tickets');
      expect(decodeURIComponent(rendered)).toContain('"@jira done"'); // stale is the only group
    });

    it('offers "Close N tickets" for selected tickets and shows closed ones without a toggle', () => {
      const stale = makeStale({
        groups: [{ issueType: 'Bug', rules: [], graph: {}, tickets: [makeStaleTicket('PROJ-1', true), makeStaleTicket('PROJ-2', true)] }],
        closedKeys: ['PROJ-2'],
      });
      const rendered = buildStaleGroupScreen(staleSession(stale), { itemNoun: 'item(s)', supportsUpdateExisting: false });
      expect(decodeURIComponent(rendered)).toContain('[Close 1 tickets]');
      const p2 = rendered.split('\n').find(l => l.includes('PROJ-2'))!;
      expect(p2).toContain('✓ closed');
      expect(decodeURIComponent(p2)).not.toContain('"@jira PROJ-2"');
    });

    it('shows each ticket\'s issue type, no fixed target, and says the target is picked next', () => {
      const stale = makeStale({
        groups: [{ issueType: 'Bug', rules: [], graph: {}, tickets: [makeStaleTicket('PROJ-1', true)] }],
      });
      const rendered = buildStaleGroupScreen(staleSession(stale), { itemNoun: 'item(s)', supportsUpdateExisting: false });
      expect(rendered).toContain('| Type |');
      expect(rendered).not.toContain('→ To');
      expect(rendered).toContain('you pick the target status next');
      expect(rendered).not.toContain('several issue types');
    });

    it('explains the one-issue-type-per-run rule when the selection spans several issue types (R12)', () => {
      const stale = makeStale({
        groups: [
          { issueType: 'Bug', rules: [], graph: {}, tickets: [makeStaleTicket('PROJ-1', true)] },
          { issueType: 'Vulnerability', rules: [], graph: {}, tickets: [makeStaleTicket('PROJ-2', true)] },
        ],
      });
      const rendered = buildStaleGroupScreen(staleSession(stale), { itemNoun: 'item(s)', supportsUpdateExisting: false });
      expect(rendered).toContain('each run closes one issue type');
    });
  });
});

// Stale-ticket target pick (docs/plans/2026-09-27-1949-feat-stale-ticket-target-pick-plan.md, U1).
describe('buildStaleTargetOptions', () => {
  const graph: WorkflowGraph = {
    'Open': [{ id: '1', name: 'Verify', to: 'Verification' }, { id: '2', name: 'Close', to: 'Done' }],
    'Verification': [{ id: '3', name: 'Accept', to: 'Done' }],
    'Reopened': [{ id: '4', name: 'Reject', to: 'Rejected' }],
  };

  it('lists matching rules first, labelled with their target, then reachable statuses alphabetically', () => {
    const options = buildStaleTargetOptions(
      [{ name: 'Close released bugs', targetState: 'Done', resolution: 'Fixed' }], graph, ['Open'],
    );

    expect(options.map(formatStaleTargetOption)).toEqual(['Close released bugs → Done', 'Done', 'Verification']);
    expect(options[0]).toEqual({ kind: 'rule', ruleName: 'Close released bugs', targetState: 'Done', resolution: 'Fixed' });
  });

  it('keeps a status that a rule also targets, since picking the plain status sets no rule resolution', () => {
    const options = buildStaleTargetOptions([{ name: 'Close', targetState: 'Done' }], graph, ['Open']);

    expect(options.filter(o => o.kind === 'status' && o.status === 'Done')).toHaveLength(1);
    expect(options.filter(o => o.kind === 'rule')).toHaveLength(1);
  });

  it('offers the union of statuses reachable from any selected ticket', () => {
    const options = buildStaleTargetOptions([], graph, ['Verification', 'Reopened', 'Verification']);

    expect(options.map(formatStaleTargetOption)).toEqual(['Done', 'Rejected']);
  });

  it('is empty when no rule matches and no selected ticket can reach anything', () => {
    expect(buildStaleTargetOptions([], graph, ['Done'])).toEqual([]);
  });
});

describe('parseStaleTargetPick', () => {
  const options: StaleTargetOption[] = [
    { kind: 'rule', ruleName: 'Close released bugs', targetState: 'Done', resolution: 'Fixed' },
    { kind: 'status', status: 'Done' },
    { kind: 'status', status: 'Verification' },
  ];

  it('picks by 1-based number', () => {
    expect(parseStaleTargetPick('3', options)).toEqual({ kind: 'status', status: 'Verification' });
  });

  it('picks a plain status by case-insensitive name, and a rule by its name', () => {
    expect(parseStaleTargetPick('done', options)).toEqual({ kind: 'status', status: 'Done' });
    expect(parseStaleTargetPick('close released bugs', options)).toEqual(options[0]);
  });

  it('treats back and cancellation words as going back', () => {
    expect(parseStaleTargetPick('back', options)).toBe('back');
    expect(parseStaleTargetPick('cancel', options)).toBe('back');
  });

  it('picks an offered status whose name is also a cancel word instead of going back', () => {
    const withCancelled: StaleTargetOption[] = [...options, { kind: 'status', status: 'Cancelled' }];
    expect(parseStaleTargetPick('Cancelled', withCancelled)).toEqual({ kind: 'status', status: 'Cancelled' });
    expect(parseStaleTargetPick('cancel', withCancelled)).toBe('back');
  });

  it('reports an unknown reply as invalid', () => {
    expect(parseStaleTargetPick('Archived', options)).toBe('invalid');
    expect(parseStaleTargetPick('9', options)).toBe('invalid');
  });
});

describe('parseStaleIssueTypePick', () => {
  const types = ['Bug', 'Vulnerability'];

  it('picks by number or case-insensitive name', () => {
    expect(parseStaleIssueTypePick('2', types)).toBe('Vulnerability');
    expect(parseStaleIssueTypePick('bug', types)).toBe('Bug');
  });

  it('picks an issue type whose name is also a cancel word instead of going back', () => {
    expect(parseStaleIssueTypePick('Stop', ['Bug', 'Stop'])).toBe('Stop');
  });

  it('goes back on back or cancel, and rejects an unknown type', () => {
    expect(parseStaleIssueTypePick('back', types)).toBe('back');
    expect(parseStaleIssueTypePick('cancel', types)).toBe('back');
    expect(parseStaleIssueTypePick('Story', types)).toBe('invalid');
  });
});

describe('selectedStaleIssueTypes', () => {
  const ticket = (key: string, included: boolean): TransitionBatchTicket => ({
    key, summary: key, currentStatus: 'Open', transitionPath: [], subtasks: [], included,
  });

  it('lists only issue types with a selected ticket not yet transitioned, in group order', () => {
    const stale: ReviewSessionStale = {
      groups: [
        { issueType: 'Bug', rules: [], graph: {}, tickets: [ticket('P-1', true)] },
        { issueType: 'Task', rules: [], graph: {}, tickets: [ticket('P-2', false)] },
        { issueType: 'Vulnerability', rules: [], graph: {}, tickets: [ticket('P-3', true)] },
      ],
      ineligible: [],
      resolutionOptions: [],
      closedKeys: ['P-3'],
    };
    expect(selectedStaleIssueTypes(stale)).toEqual(['Bug']);
  });
});

describe('staleTargetNeedsResolution (R3/R4/KTD5)', () => {
  const resolutions = ['Fixed', "Won't Do"];

  it('never asks for a rule that names its own resolution', () => {
    expect(staleTargetNeedsResolution({ kind: 'rule', ruleName: 'r', targetState: 'Done', resolution: 'Fixed' }, resolutions)).toBe(false);
  });

  it('asks for a closed-like target from a rule without a resolution or from a plain status', () => {
    expect(staleTargetNeedsResolution({ kind: 'rule', ruleName: 'r', targetState: 'Done' }, resolutions)).toBe(true);
    expect(staleTargetNeedsResolution({ kind: 'status', status: 'Closed' }, resolutions)).toBe(true);
  });

  it('never asks for a non-final status, or when the instance has no resolutions', () => {
    expect(staleTargetNeedsResolution({ kind: 'status', status: 'Verification' }, resolutions)).toBe(false);
    expect(staleTargetNeedsResolution({ kind: 'status', status: 'Done' }, [])).toBe(false);
  });
});

describe('planStaleTransitions (KTD2/R11)', () => {
  const graph: WorkflowGraph = {
    'Open': [{ id: '1', name: 'Verify', to: 'Verification' }],
    'Verification': [{ id: '2', name: 'Accept', to: 'Done' }],
  };
  const t = (key: string, currentStatus: string, included = true): TransitionBatchTicket => ({
    key, summary: key, currentStatus, transitionPath: [], subtasks: [], included,
  });

  it('builds a path from the stored graph for each selected ticket, multi-hop included', () => {
    const group: StaleTicketGroup = { issueType: 'Bug', rules: [], graph, tickets: [t('P-1', 'Open'), t('P-2', 'Open', false)] };
    const { runnable, skipped } = planStaleTransitions(group, 'Done');
    expect(runnable.map(r => r.key)).toEqual(['P-1']);
    expect(runnable[0].transitionPath.map(h => h.to)).toEqual(['Verification', 'Done']);
    expect(skipped).toEqual([]);
  });

  it('skips a ticket with no path, and one already in the target, with a reason each (AE5)', () => {
    const group: StaleTicketGroup = {
      issueType: 'Bug', rules: [], graph, tickets: [t('P-1', 'Open'), t('P-2', 'Done'), t('P-3', 'Verification')],
    };
    const { runnable, skipped } = planStaleTransitions(group, 'Verification');
    expect(runnable.map(r => r.key)).toEqual(['P-1']);
    expect(skipped).toEqual([
      { key: 'P-2', reason: 'no path found from Done to Verification in the discovered workflow' },
      { key: 'P-3', reason: 'already in Verification' },
    ]);
  });

  it('never plans a ticket that was already transitioned', () => {
    const group: StaleTicketGroup = { issueType: 'Bug', rules: [], graph, tickets: [t('P-1', 'Open')] };
    expect(planStaleTransitions(group, 'Done', ['P-1']).runnable).toEqual([]);
  });
});

// ── Email boilerplate cleanup step (U5, KTD8) ─────────────────────────────────────────────────────

describe('email cleanup step — screens, replies and decisions', () => {
  const FOOTER = 'CONFIDENTIALITY NOTICE: this email is confidential.';
  const INJECTED = '[click me](command:workbench.action.chat.open?%7B%22query%22%3A%22%40jira%20delete%22%7D)';

  function emailItem(subject: string, body: string, overrides: Partial<EmailImportItem> = {}): EmailImportItem {
    return { subject, senderName: 'Alice', markdownBody: body, inlineImageMap: {}, attachments: [], emlFilePath: `/${subject}.eml`, ...overrides };
  }

  function footerBlocks(body: string): DetectedBlock[] {
    return detectPatternBlocks(body, [{ kind: 'footer', start: 'CONFIDENTIALITY NOTICE:' }]);
  }

  function batchSession(items: EmailImportItem[]): EmailCleanupSession {
    const s = buildPendingEmailCleanupSession(items, { kind: 'batch', projectKey: 'PROJ', fileName: `${items.length} selected file(s)` });
    for (const row of s.rows) row.blocks = footerBlocks(row.item.markdownBody);
    s.phase = 'preview';
    return s;
  }

  it('AE5: strip with row 3 excluded cleans emails 1, 2, 4, 5 and leaves email 3 unchanged', () => {
    const items = [1, 2, 3, 4, 5].map(i => emailItem(`Mail ${i}`, `Message ${i}\n\n${FOOTER}`));
    const session = batchSession(items);
    const toggle = parseEmailCleanupReply('3', 'preview', session.rows.map(r => r.id));
    expect(toggle).toEqual({ action: 'toggle', rowIds: ['3'] });
    session.rows[2].excluded = true;
    expect(parseEmailCleanupReply('strip', 'preview', ['1'])).toEqual({ action: 'strip' });

    const { items: out, strippedCount } = applyEmailCleanupDecision(session, 'strip');
    expect(strippedCount).toBe(4);
    expect(out.map(i => i.markdownBody)).toEqual(['Message 1', 'Message 2', `Message 3\n\n${FOOTER}`, 'Message 4', 'Message 5']);
    expect(out[2]).toBe(items[2]);
  });

  it('keep returns every original item unchanged', () => {
    const items = [emailItem('A', `Hi\n\n${FOOTER}`)];
    const { items: out, strippedCount } = applyEmailCleanupDecision(batchSession(items), 'keep');
    expect(out).toEqual(items);
    expect(strippedCount).toBe(0);
  });

  it('AE7: a stacked-footer email shows "3 footers, 1 signature" with line counts in the preview', async () => {
    const mail = await parseEmlFile(nodePath.resolve(process.cwd(), 'src/test/fixtures/eml/chain-stacked-footers.eml'));
    const session = buildPendingEmailCleanupSession([mail], { kind: 'batch', projectKey: 'PROJ', fileName: 'x.eml' });
    session.rows[0].blocks = detectPatternBlocks(mail.markdownBody, [
      { kind: 'signature', start: 'Best regards,' },
      { kind: 'footer', start: 'LEGAL NOTICE:' },
      { kind: 'footer', start: 'CONFIDENTIALITY NOTICE:' },
      { kind: 'footer', start: 'DATA PROTECTION:' },
    ], mail.senderName);
    session.phase = 'preview';
    const text = buildEmailCleanupPreview(session);
    expect(text).toContain('3 footers, 1 signature');
    expect(text).toContain('1 image(s) would be dropped');
    expect(text).toMatch(/#1 signature \(pattern\), 5 lines/);
    expect(text).toMatch(/#2 footer \(pattern\), 2 lines: “LEGAL NOTICE:/);
    expect(text).toMatch(/#4 footer \(pattern\), 1 line: “DATA PROTECTION:/);
  });

  it('a capped block shows "capped" next to its line count (AE8)', () => {
    const body = ['Hi', '', 'Best regards,', ...Array.from({ length: 45 }, (_, i) => `line ${i}`)].join('\n');
    const session = buildPendingEmailCleanupSession([emailItem('Long', body)], { kind: 'batch', projectKey: 'PROJ', fileName: 'x' });
    session.rows[0].blocks = detectPatternBlocks(body, [{ kind: 'signature', start: 'Best regards,' }]);
    expect(buildEmailCleanupPreview(session)).toContain('40 lines, capped');
  });

  it('rows with nothing detected say so, including why the model did not run', () => {
    const session = batchSession([emailItem('Plain', 'Just text'), emailItem('Other', `x\n\n${FOOTER}`)]);
    session.rows[0].modelStatus = 'declined';
    expect(buildEmailCleanupPreview(session)).toContain('**1** · Plain — nothing detected (model check skipped)');
    session.rows[0].modelStatus = 'too-long';
    expect(buildEmailCleanupPreview(session)).toContain('nothing detected (too long for model check)');
  });

  it('a command: link in the subject and in the excerpt renders inert on both the consent and preview screens', () => {
    const body = `Hello\n\nCONFIDENTIALITY NOTICE: ${INJECTED}`;
    const session = batchSession([emailItem(`Re: ${INJECTED}`, body), emailItem(`Other ${INJECTED}`, 'plain body')]);
    session.rows[1].modelStatus = 'awaiting-consent';
    const consent = buildEmailCleanupConsent(session);
    const preview = buildEmailCleanupPreview(session);
    for (const text of [consent, preview]) {
      expect(text).not.toContain('[click me](command:');
      expect(text).toContain('［click me］(command:');
    }
    expect(preview).toContain('Re: ［click me］');
  });

  it('an angle-bracket autolink in a subject or excerpt renders inert on both the consent and preview screens', () => {
    const autolink = '<command:workbench.action.chat.open?%5B%22x%22%5D>';
    const body = `Hello\n\nCONFIDENTIALITY NOTICE: <https://evil.example/x>`;
    const session = batchSession([emailItem(`Re: ${autolink}`, body), emailItem(autolink, 'plain body')]);
    session.rows[1].modelStatus = 'awaiting-consent';
    const consent = buildEmailCleanupConsent(session);
    const preview = buildEmailCleanupPreview(session);
    for (const text of [consent, preview]) {
      expect(text).not.toMatch(/(^|[^\\])<command:/);
      expect(text).toContain('\\<command:workbench.action.chat.open');
    }
    expect(preview).not.toMatch(/(^|[^\\])<https:\/\/evil/);
    expect(preview).toContain('\\<https://evil.example/x>');
  });

  it('the consent screen lists only the unmatched emails and offers model check / skip model', () => {
    const session = batchSession([emailItem('Matched', `x\n\n${FOOTER}`), emailItem('Unmatched', 'plain')]);
    session.rows[1].modelStatus = 'awaiting-consent';
    const text = buildEmailCleanupConsent(session);
    expect(text).toContain('**1** of 2 email(s) had no match');
    expect(text).toContain('**2** · Unmatched');
    expect(text).not.toContain('**1** · Matched');
    expect(decodeURIComponent(text)).toContain('"@jira model check"');
    expect(decodeURIComponent(text)).toContain('"@jira skip model"');
  });

  it('parses consent replies: model check / yes consent, skip model / no decline, cancel', () => {
    expect(parseEmailCleanupReply('model check', 'consent', [])).toEqual({ action: 'model-check' });
    expect(parseEmailCleanupReply('Yes', 'consent', [])).toEqual({ action: 'model-check' });
    expect(parseEmailCleanupReply('skip model', 'consent', [])).toEqual({ action: 'skip-model' });
    expect(parseEmailCleanupReply('no', 'consent', [])).toEqual({ action: 'skip-model' });
    expect(parseEmailCleanupReply('cancel', 'consent', [])).toEqual({ action: 'cancel' });
    expect(parseEmailCleanupReply('strip', 'consent', [])).toEqual({ action: 'invalid' });
    // A bare "check" is routed to the connection check before any session router, so it is not a consent word
    expect(parseEmailCleanupReply('check', 'consent', [])).toEqual({ action: 'invalid' });
  });

  it('parses preview replies: keep, save <n>, several row ids, unknown ids and model check are invalid', () => {
    expect(parseEmailCleanupReply('keep', 'preview', ['1'])).toEqual({ action: 'keep' });
    expect(parseEmailCleanupReply('save 2', 'preview', ['1'])).toEqual({ action: 'save', blockNumber: 2 });
    expect(parseEmailCleanupReply('save #3', 'preview', ['1'])).toEqual({ action: 'save', blockNumber: 3 });
    expect(parseEmailCleanupReply('1, 2', 'preview', ['1', '2'])).toEqual({ action: 'toggle', rowIds: ['1', '2'] });
    expect(parseEmailCleanupReply('7', 'preview', ['1', '2'])).toEqual({ action: 'invalid' });
    expect(parseEmailCleanupReply('model check', 'preview', ['1'])).toEqual({ action: 'invalid' });
    expect(parseEmailCleanupReply('cancel', 'preview', ['1'])).toEqual({ action: 'cancel' });
  });

  it('a model-found block offers save <n> with the exact phrases it would store; a pattern block does not', () => {
    const body = 'Hi\n\nThis mail and attachments are private.\nDelete it if misdirected.';
    const session = batchSession([emailItem('A', body)]);
    session.rows[0].blocks = [
      { kind: 'footer', segmentIndex: 0, startLine: 2, endLine: 3, excerpt: 'This mail and attachments are private.', nonEmptyLineCount: 2, capped: false, source: 'model' },
    ];
    const text = buildEmailCleanupPreview(session);
    expect(decodeURIComponent(text)).toContain('"@jira save 1"');
    expect(text).toContain('would store start “This mail and attachments are private.”, end “Delete it if misdirected.”');
    expect(resolveSaveTarget(session, 1)).toEqual({ ok: true, pattern: { kind: 'footer', start: 'This mail and attachments are private.', end: 'Delete it if misdirected.' } });

    const patternSession = batchSession([emailItem('B', `x\n\n${FOOTER}`)]);
    expect(buildEmailCleanupPreview(patternSession)).not.toContain('save 1');
    expect(resolveSaveTarget(patternSession, 1)).toEqual({ ok: false, reason: 'pattern-found' });
    expect(resolveSaveTarget(patternSession, 9)).toEqual({ ok: false, reason: 'unknown' });
  });

  it('describeBlockKinds orders kinds and pluralizes', () => {
    const mk = (kind: DetectedBlock['kind']): DetectedBlock => ({ kind, segmentIndex: 0, startLine: 0, endLine: 0, excerpt: '', nonEmptyLineCount: 1, capped: false, source: 'pattern' });
    expect(describeBlockKinds([mk('signature'), mk('footer'), mk('footer'), mk('header')])).toBe('1 header, 2 footers, 1 signature');
  });
});
