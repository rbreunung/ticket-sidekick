import { describe, it, expect } from 'vitest';
import { renderReviewTable, buildJiraNotConfiguredMessage, buildChatCommandLink, isGreetingOrEmpty, computeJiraFollowups, type ReviewTableColumn, type JiraFollowupState } from '../participant/sessionState';

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
  it('returns example prompts for a greeting, capped at 3', () => {
    const chips = computeJiraFollowups({ kind: 'greeting' });

    expect(chips.length).toBeGreaterThan(0);
    expect(chips.length).toBeLessThanOrEqual(3);
    for (const chip of chips) {
      expect(chip.prompt.length).toBeGreaterThan(0);
    }
  });

  it('returns example prompts for the unclassifiable-prompt fallback, capped at 3', () => {
    const chips = computeJiraFollowups({ kind: 'fallback' });

    expect(chips.length).toBeGreaterThan(0);
    expect(chips.length).toBeLessThanOrEqual(3);
  });

  it('returns "add a comment"/"transition it"-shaped chips after loading a ticket', () => {
    const state: JiraFollowupState = { kind: 'loadedTicket', ticketKey: 'PROJ-123' };

    const chips = computeJiraFollowups(state);

    expect(chips.length).toBeLessThanOrEqual(3);
    expect(chips.some((c) => /comment/i.test(c.prompt) || /comment/i.test(c.label ?? ''))).toBe(true);
    expect(chips.some((c) => /transition/i.test(c.prompt) || /transition/i.test(c.label ?? ''))).toBe(true);
    // The prompt itself names the real ticket key so it works without relying on pronoun
    // resolution against chat history.
    expect(chips.every((c) => c.prompt.includes('PROJ-123'))).toBe(true);
  });

  it('omits the "add a comment" chip right after addComment succeeded', () => {
    const state: JiraFollowupState = { kind: 'loadedTicket', ticketKey: 'PROJ-123', justDid: 'addComment' };

    const chips = computeJiraFollowups(state);

    expect(chips.some((c) => /add a comment/i.test(c.prompt))).toBe(false);
    expect(chips.some((c) => /transition/i.test(c.prompt))).toBe(true);
  });

  it('omits the "transition it" chip right after transition succeeded', () => {
    const state: JiraFollowupState = { kind: 'loadedTicket', ticketKey: 'PROJ-123', justDid: 'transition' };

    const chips = computeJiraFollowups(state);

    expect(chips.some((c) => /transition/i.test(c.prompt))).toBe(false);
    expect(chips.some((c) => /add a comment/i.test(c.prompt))).toBe(true);
  });

  it('returns no chips when there is no prior operation state', () => {
    expect(computeJiraFollowups({ kind: 'none' })).toEqual([]);
  });
});
