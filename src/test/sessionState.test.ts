import { describe, it, expect } from 'vitest';
import { renderReviewTable, buildJiraNotConfiguredMessage, buildChatCommandLink, neutralizeMarkdownLinks, isGreetingOrEmpty, computeJiraFollowups, withLastTicket, type ReviewTableColumn, type JiraFollowupState } from '../participant/sessionState';
import { buildChatCommandLink } from '../participant/sessionState';

interface Widget {
  name: string;
  qty: number;
}

const WIDGET_COLUMNS: ReviewTableColumn<Widget>[] = [
  { header: 'Name', accessor: (w) => w.name },
  { header: 'Qty', accessor: (w) => String(w.qty) },
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
