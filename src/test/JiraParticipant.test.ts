import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', () => ({
  window: { createOutputChannel: vi.fn(() => ({ appendLine: vi.fn() })) },
}));

import { extractLastTicketFromText, isConfirmation, isCancellation, serializeTurns, stripHiddenMarkers, parseSkipInput, parseResolutionSelection, parseCommentIndex, buildCommentListSession, formatCommentsInFull, parseFilterSelection, parseBulkUpdateReview, rewriteAttachmentLinks, parseSkippedAttachmentSelection, pickEmailOption, buildTeamJql, selectDefaultIssueType, buildImportReviewTable, parseReviewInput, applyReviewToggle, VERACODE_REVIEW_COLUMNS, WALTZ_REVIEW_COLUMNS, isSessionExpired, SESSION_EXPIRED_MESSAGE, CURRENT_SESSION_SCHEMA_VERSION, buildBulkUpdateReviewTable, type VeracodeReviewRow, type BulkUpdateReviewRow } from '../participant/sessionState';
import type { WaltzReviewRow } from '../utils/waltzReport';
import { isPointerPrompt } from '../participant/jira/llmHelpers';
import type { TransitionBatchTicket } from '../participant/sessionState';
import type { JiraComment } from '../jira/IJiraClient';

describe('stripHiddenMarkers', () => {
  it('removes a jira-ticket marker', () => {
    expect(stripHiddenMarkers('Done.\n\n<!-- @jira-ticket:PROJ-1 -->')).toBe('Done.');
  });

  it('removes a jira:creating compact tag', () => {
    const text = 'Next question\n\n<!-- jira:creating -->';
    expect(stripHiddenMarkers(text)).toBe('Next question');
  });

  it('returns unchanged text when no markers present', () => {
    expect(stripHiddenMarkers('No markers here')).toBe('No markers here');
  });
});

describe('serializeTurns', () => {
  const turns = [
    { role: 'user' as const, text: 'Show me PROJ-1' },
    { role: 'assistant' as const, text: 'Here is the ticket.' },
    { role: 'user' as const, text: 'Write a poem about it' },
    { role: 'assistant' as const, text: 'Roses are red...' },
    { role: 'user' as const, text: 'Add that poem as a comment' },
  ];

  it('includes all turns in full mode', () => {
    const result = serializeTurns(turns, 'full');
    expect(result).toContain('Show me PROJ-1');
    expect(result).toContain('Roses are red');
  });

  it('includes all turns when total is within the 10-turn recent window', () => {
    const result = serializeTurns(turns, 'recent');
    expect(result).toContain('Show me PROJ-1');
    expect(result).toContain('Roses are red');
    expect(result).toContain('Add that poem as a comment');
  });

  it('labels turns with User and Assistant prefixes', () => {
    const result = serializeTurns([{ role: 'user', text: 'hello' }, { role: 'assistant', text: 'world' }], 'full');
    expect(result).toBe('User: hello\n\nAssistant: world');
  });

  it('filters out empty text turns', () => {
    const result = serializeTurns([{ role: 'user', text: '' }, { role: 'assistant', text: 'hi' }], 'full');
    expect(result).toBe('Assistant: hi');
  });

  it('includes turns 5–14 (last 10) when 15 turns are provided in recent mode', () => {
    const manyTurns = Array.from({ length: 15 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      text: `message-${i}`,
    }));
    const result = serializeTurns(manyTurns, 'recent');
    expect(result).not.toContain('message-0');
    expect(result).not.toContain('message-4');
    expect(result).toContain('message-5');
    expect(result).toContain('message-14');
  });

  it('truncates serialized history exceeding 30 000 chars and adds note', () => {
    const manyTurns = Array.from({ length: 10 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      text: `turn-${i}-` + 'a'.repeat(4000),
    }));
    const result = serializeTurns(manyTurns, 'full');
    expect(result).toContain('_(oldest turns omitted to fit context)_');
    expect(result).not.toContain(manyTurns[0].text.slice(0, 50));
    expect(result).toContain(manyTurns[9].text.slice(0, 50));
    expect(result).toMatch(/omitted to fit context\)_\n\n(User|Assistant): /);
  });

  it('truncates in recent mode when the last 10 turns exceed 30 000 chars', () => {
    const longText = 'b'.repeat(4000);
    const manyTurns = Array.from({ length: 10 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      text: `recent-${i}-${longText}`,
    }));
    const result = serializeTurns(manyTurns, 'recent');
    expect(result).toContain('_(oldest turns omitted to fit context)_');
  });

  it('does not add truncation note when history is short', () => {
    const result = serializeTurns([{ role: 'user' as const, text: 'hello' }], 'full');
    expect(result).not.toContain('oldest turns omitted');
  });
});

describe('extractLastTicketFromText', () => {
  it('extracts ticket key from marker', () => {
    expect(extractLastTicketFromText('some response\n\n<!-- @jira-ticket:VSJI-2 -->')).toBe('VSJI-2');
  });

  it('returns null when no marker present', () => {
    expect(extractLastTicketFromText('no marker here')).toBeNull();
  });

  it('handles multi-segment project keys', () => {
    expect(extractLastTicketFromText('<!-- @jira-ticket:PROJ-123 -->')).toBe('PROJ-123');
  });
});


describe('isConfirmation', () => {
  it('returns true for "post it"', () => {
    expect(isConfirmation('post it')).toBe(true);
  });

  it('returns true for "yes"', () => {
    expect(isConfirmation('yes')).toBe(true);
  });

  it('returns true for case-insensitive match', () => {
    expect(isConfirmation('Yes')).toBe(true);
  });

  it('returns true for "looks good"', () => {
    expect(isConfirmation('looks good')).toBe(true);
  });

  it('returns true for "post" alone, not just "post it" (R5)', () => {
    expect(isConfirmation('post')).toBe(true);
    expect(isConfirmation('post it')).toBe(true);
  });

  it('returns false for a refinement instruction', () => {
    expect(isConfirmation('make it shorter')).toBe(false);
  });

  it('returns false for "cancel"', () => {
    expect(isConfirmation('cancel')).toBe(false);
  });
});

describe('isCancellation', () => {
  it('returns true for "cancel"', () => {
    expect(isCancellation('cancel')).toBe(true);
  });

  it('returns true for "never mind"', () => {
    expect(isCancellation('never mind')).toBe(true);
  });

  it('returns true for "nevermind"', () => {
    expect(isCancellation('nevermind')).toBe(true);
  });

  it('returns false for "post it"', () => {
    expect(isCancellation('post it')).toBe(false);
  });

  it('returns false for a refinement instruction', () => {
    expect(isCancellation('make it more formal')).toBe(false);
  });
});


describe('isConfirmation (load-more phrases)', () => {
  it('returns true for "load all"', () => {
    expect(isConfirmation('load all')).toBe(true);
  });

  it('returns true for "load more"', () => {
    expect(isConfirmation('load more')).toBe(true);
  });

  it('returns true for "show all"', () => {
    expect(isConfirmation('show all')).toBe(true);
  });

  it('returns true for "show more"', () => {
    expect(isConfirmation('show more')).toBe(true);
  });
});

describe('parseSkipInput', () => {
  const tickets: TransitionBatchTicket[] = [
    {
      key: 'PROJ-10', summary: 'Login bug', currentStatus: 'In Review',
      transitionPath: [{ id: '41', name: 'Approve', to: 'Done' }],
      subtasks: [
        { key: 'PROJ-11', summary: 'Write tests', currentStatus: 'In Progress', transitionPath: [] },
        { key: 'PROJ-12', summary: 'Code review', currentStatus: 'Open', transitionPath: [] },
      ],
    },
    {
      key: 'PROJ-14', summary: 'Dark mode', currentStatus: 'Blocked',
      transitionPath: [], subtasks: [],
    },
  ];

  it('returns ok for "ok"', () => {
    expect(parseSkipInput('ok', tickets)).toEqual({ action: 'ok' });
  });

  it('returns cancel for "c" and "cancel"', () => {
    expect(parseSkipInput('c', tickets)).toEqual({ action: 'cancel' });
    expect(parseSkipInput('cancel', tickets)).toEqual({ action: 'cancel' });
  });

  it('skipping a subtask also skips the parent', () => {
    const result = parseSkipInput('11', tickets);
    expect(result).toMatchObject({ action: 'skip' });
    expect((result as { action: 'skip'; keys: string[] }).keys).toContain('PROJ-11');
    expect((result as { action: 'skip'; keys: string[] }).keys).toContain('PROJ-10');
  });

  it('skipping a parent also skips all its subtasks', () => {
    const result = parseSkipInput('10', tickets);
    expect(result).toMatchObject({ action: 'skip' });
    const keys = (result as { action: 'skip'; keys: string[] }).keys;
    expect(keys).toContain('PROJ-10');
    expect(keys).toContain('PROJ-11');
    expect(keys).toContain('PROJ-12');
  });

  it('skips multiple groups', () => {
    const result = parseSkipInput('11 14', tickets);
    const keys = (result as { action: 'skip'; keys: string[] }).keys;
    expect(keys).toContain('PROJ-11');
    expect(keys).toContain('PROJ-10');
    expect(keys).toContain('PROJ-14');
  });

  it('returns invalid for unrecognised input', () => {
    expect(parseSkipInput('something', tickets)).toEqual({ action: 'invalid' });
    expect(parseSkipInput('', tickets)).toEqual({ action: 'invalid' });
  });

  it('trims whitespace', () => {
    expect(parseSkipInput('  ok  ', tickets)).toEqual({ action: 'ok' });
  });

  it('also recognizes other shared confirmation/cancellation words, not just ok/c/cancel', () => {
    expect(parseSkipInput('yes', tickets)).toEqual({ action: 'ok' });
    expect(parseSkipInput('stop', tickets)).toEqual({ action: 'cancel' });
  });
});

describe('parseResolutionSelection', () => {
  const options = ['Fixed', "Won't Fix", 'Duplicate', 'Done'];

  it('selects by 1-based number', () => {
    expect(parseResolutionSelection('1', options)).toBe('Fixed');
    expect(parseResolutionSelection('3', options)).toBe('Duplicate');
  });

  it('selects by exact name (case-insensitive)', () => {
    expect(parseResolutionSelection('fixed', options)).toBe('Fixed');
    expect(parseResolutionSelection('DONE', options)).toBe('Done');
  });

  it('returns null for "none"', () => {
    expect(parseResolutionSelection('none', options)).toBeNull();
  });

  it('returns null for "skip"', () => {
    expect(parseResolutionSelection('skip', options)).toBeNull();
  });

  it('returns invalid for out-of-range number', () => {
    expect(parseResolutionSelection('0', options)).toBe('invalid');
    expect(parseResolutionSelection('5', options)).toBe('invalid');
  });

  it('returns invalid for unrecognised text', () => {
    expect(parseResolutionSelection('maybe', options)).toBe('invalid');
  });

  it('trims whitespace before matching', () => {
    expect(parseResolutionSelection('  2  ', options)).toBe("Won't Fix");
    expect(parseResolutionSelection('  none  ', options)).toBeNull();
  });
});

describe('parseCommentIndex', () => {
  it('returns the number when reply is just a digit', () => {
    expect(parseCommentIndex('3', 5)).toBe(3);
  });

  it('extracts number from "show comment 3"', () => {
    expect(parseCommentIndex('show comment 3', 5)).toBe(3);
  });

  it('extracts number from "comment 2"', () => {
    expect(parseCommentIndex('comment 2', 5)).toBe(2);
  });

  it('extracts number from "full comment 4"', () => {
    expect(parseCommentIndex('full comment 4', 5)).toBe(4);
  });

  it('returns invalid for non-numeric input', () => {
    expect(parseCommentIndex('first comment', 5)).toBe('invalid');
  });

  it('returns invalid when number exceeds maxIndex', () => {
    expect(parseCommentIndex('10', 5)).toBe('invalid');
  });

  it('returns invalid for 0', () => {
    expect(parseCommentIndex('0', 5)).toBe('invalid');
  });

  it('returns invalid when no digit present', () => {
    expect(parseCommentIndex('show me the comments', 5)).toBe('invalid');
  });

  it('handles whitespace around the number', () => {
    expect(parseCommentIndex('  2  ', 5)).toBe(2);
  });
});

describe('buildCommentListSession', () => {
  const makeComment = (id: string, displayName: string, text: string, created: string): JiraComment => ({
    id,
    author: { accountId: id, displayName, emailAddress: `${id}@x.com` },
    body: {
      type: 'doc', version: 1,
      content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
    },
    created,
  });

  it('sets ticketKey on the session', () => {
    const session = buildCommentListSession('PROJ-42', []);
    expect(session.ticketKey).toBe('PROJ-42');
  });

  it('assigns 1-based indices', () => {
    const comments = [
      makeComment('1', 'Alice', 'First', '2024-01-01T00:00:00.000Z'),
      makeComment('2', 'Bob', 'Second', '2024-01-02T00:00:00.000Z'),
    ];
    const session = buildCommentListSession('PROJ-1', comments);
    expect(session.comments[0].index).toBe(1);
    expect(session.comments[1].index).toBe(2);
  });

  it('formats dates as YYYY-MM-DD', () => {
    const comments = [makeComment('1', 'Alice', 'Hi', '2024-03-15T09:30:00.000Z')];
    const session = buildCommentListSession('PROJ-1', comments);
    expect(session.comments[0].date).toBe('2024-03-15');
  });

  it('stores author display name', () => {
    const comments = [makeComment('1', 'Jane Doe', 'Hello', '2024-01-01T00:00:00.000Z')];
    const session = buildCommentListSession('PROJ-1', comments);
    expect(session.comments[0].author).toBe('Jane Doe');
  });

  it('converts ADF body to Markdown', () => {
    const comment: JiraComment = {
      id: '1',
      author: { accountId: 'a', displayName: 'Alice', emailAddress: 'a@x.com' },
      body: {
        type: 'doc', version: 1,
        content: [{
          type: 'paragraph',
          content: [{ type: 'text', text: 'bold word', marks: [{ type: 'strong' }] }],
        }],
      },
      created: '2024-01-01T00:00:00.000Z',
    };
    const session = buildCommentListSession('PROJ-1', [comment]);
    expect(session.comments[0].bodyMarkdown).toContain('**bold word**');
  });

  it('converts wiki-markup body (v2 string) to Markdown', () => {
    const comment: JiraComment = {
      id: '1',
      author: { accountId: 'a', displayName: 'Alice', emailAddress: 'a@x.com' },
      body: '*bold*',
      created: '2024-01-01T00:00:00.000Z',
    };
    const session = buildCommentListSession('PROJ-1', [comment]);
    expect(session.comments[0].bodyMarkdown).toContain('**bold**');
  });

  it('falls back to _empty_ when body produces no text', () => {
    const comment: JiraComment = {
      id: '1',
      author: { accountId: 'a', displayName: 'Alice', emailAddress: 'a@x.com' },
      body: { type: 'doc', version: 1, content: [] },
      created: '2024-01-01T00:00:00.000Z',
    };
    const session = buildCommentListSession('PROJ-1', [comment]);
    expect(session.comments[0].bodyMarkdown).toBe('_empty_');
  });

  it('returns empty comments array when passed no comments', () => {
    const session = buildCommentListSession('PROJ-1', []);
    expect(session.comments).toHaveLength(0);
  });
});

describe('formatCommentsInFull', () => {
  const makeComment = (id: string, displayName: string, body: unknown, created: string): JiraComment => ({
    id,
    author: { accountId: id, displayName, emailAddress: `${id}@x.com` },
    body,
    created,
  });

  it('numbers comments starting from 1', () => {
    const comments = [
      makeComment('1', 'Alice', 'First comment', '2024-01-01T00:00:00.000Z'),
      makeComment('2', 'Bob', 'Second comment', '2024-01-02T00:00:00.000Z'),
    ];
    const result = formatCommentsInFull(comments);
    expect(result).toContain('**1. Alice**');
    expect(result).toContain('**2. Bob**');
  });

  it('includes formatted date in parentheses', () => {
    const comments = [makeComment('1', 'Alice', 'Hi', '2024-03-15T09:30:00.000Z')];
    const result = formatCommentsInFull(comments);
    expect(result).toContain('(2024-03-15)');
  });

  it('includes the comment body on a new paragraph', () => {
    const comments = [makeComment('1', 'Alice', 'Hello world', '2024-01-01T00:00:00.000Z')];
    const result = formatCommentsInFull(comments);
    expect(result).toContain('\n\nHello world');
  });

  it('separates multiple comments with a horizontal rule', () => {
    const comments = [
      makeComment('1', 'Alice', 'First', '2024-01-01T00:00:00.000Z'),
      makeComment('2', 'Bob', 'Second', '2024-01-02T00:00:00.000Z'),
    ];
    const result = formatCommentsInFull(comments);
    expect(result).toContain('\n\n---\n\n');
  });

  it('converts ADF body to Markdown', () => {
    const comment = makeComment('1', 'Alice', {
      type: 'doc', version: 1,
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'bold', marks: [{ type: 'strong' }] }] }],
    }, '2024-01-01T00:00:00.000Z');
    const result = formatCommentsInFull([comment]);
    expect(result).toContain('**bold**');
  });

  it('converts wiki-markup string body to Markdown', () => {
    const comment = makeComment('1', 'Alice', '*bold*', '2024-01-01T00:00:00.000Z');
    const result = formatCommentsInFull([comment]);
    expect(result).toContain('**bold**');
  });

  it('shows _empty_ for blank body', () => {
    const comment = makeComment('1', 'Alice', { type: 'doc', version: 1, content: [] }, '2024-01-01T00:00:00.000Z');
    const result = formatCommentsInFull([comment]);
    expect(result).toContain('_empty_');
  });

  it('returns empty string for no comments', () => {
    expect(formatCommentsInFull([])).toBe('');
  });
});

describe('parseFilterSelection', () => {
  const filters = [
    { id: '10001', name: 'My open bugs', jql: 'assignee = currentUser() AND status != Done' },
    { id: '10002', name: 'My open tasks', jql: 'assignee = currentUser() AND issuetype = Task' },
    { id: '10003', name: 'Team backlog', jql: 'project = PROJ AND status = Backlog' },
  ];

  it('selects by 1-based index', () => {
    expect(parseFilterSelection('1', filters)).toEqual(filters[0]);
    expect(parseFilterSelection('2', filters)).toEqual(filters[1]);
    expect(parseFilterSelection('3', filters)).toEqual(filters[2]);
  });

  it('selects by exact name (case-insensitive)', () => {
    expect(parseFilterSelection('My open bugs', filters)).toEqual(filters[0]);
    expect(parseFilterSelection('my open bugs', filters)).toEqual(filters[0]);
    expect(parseFilterSelection('TEAM BACKLOG', filters)).toEqual(filters[2]);
  });

  it('returns cancel for c / cancel', () => {
    expect(parseFilterSelection('c', filters)).toBe('cancel');
    expect(parseFilterSelection('cancel', filters)).toBe('cancel');
    expect(parseFilterSelection('Cancel', filters)).toBe('cancel');
  });

  it('returns invalid for out-of-range index', () => {
    expect(parseFilterSelection('0', filters)).toBe('invalid');
    expect(parseFilterSelection('4', filters)).toBe('invalid');
  });

  it('returns invalid for unrecognised text', () => {
    expect(parseFilterSelection('something else', filters)).toBe('invalid');
  });

  it('also recognizes other shared cancellation words, not just c/cancel', () => {
    expect(parseFilterSelection('stop', filters)).toBe('cancel');
    expect(parseFilterSelection('never mind', filters)).toBe('cancel');
  });

  it('selects a real filter by name even when it collides with a cancellation word', () => {
    const collidingFilters = [
      { id: '10001', name: 'Stop', jql: 'status = Blocked' },
      { id: '10002', name: 'My open tasks', jql: 'assignee = currentUser() AND issuetype = Task' },
    ];
    expect(parseFilterSelection('Stop', collidingFilters)).toEqual(collidingFilters[0]);
    expect(parseFilterSelection('stop', collidingFilters)).toEqual(collidingFilters[0]);
  });
});

describe('parseBulkUpdateReview', () => {
  it('returns ok with empty skip list for "ok"', () => {
    expect(parseBulkUpdateReview('ok')).toEqual({ action: 'ok', skip: [] });
    expect(parseBulkUpdateReview('yes')).toEqual({ action: 'ok', skip: [] });
    expect(parseBulkUpdateReview('OK')).toEqual({ action: 'ok', skip: [] });
  });

  it('returns ok with skip keys when user lists keys to skip', () => {
    expect(parseBulkUpdateReview('skip PROJ-2 PROJ-5')).toEqual({ action: 'ok', skip: ['PROJ-2', 'PROJ-5'] });
    expect(parseBulkUpdateReview('skip PROJ-1')).toEqual({ action: 'ok', skip: ['PROJ-1'] });
  });

  it('returns cancel for c / cancel', () => {
    expect(parseBulkUpdateReview('c')).toEqual({ action: 'cancel' });
    expect(parseBulkUpdateReview('cancel')).toEqual({ action: 'cancel' });
    expect(parseBulkUpdateReview('Cancel')).toEqual({ action: 'cancel' });
  });

  it('returns invalid for unrecognised input', () => {
    expect(parseBulkUpdateReview('something else')).toEqual({ action: 'invalid' });
    expect(parseBulkUpdateReview('')).toEqual({ action: 'invalid' });
  });

  it('also recognizes other shared confirmation/cancellation words, not just ok/c/cancel', () => {
    expect(parseBulkUpdateReview('confirm')).toEqual({ action: 'ok', skip: [] });
    expect(parseBulkUpdateReview('stop')).toEqual({ action: 'cancel' });
  });

  it('a bare "skip" with no keys now cancels — no flow-specific exception (R6)', () => {
    expect(parseBulkUpdateReview('skip')).toEqual({ action: 'cancel' });
  });
});

describe('buildBulkUpdateReviewTable', () => {
  it('renders Key / Summary / Current value columns matching the current inline output', () => {
    const rows: BulkUpdateReviewRow[] = [
      { key: 'PROJ-1', summary: 'Fix login bug', currentValueDisplay: 'High' },
      { key: 'PROJ-2', summary: 'Update docs', currentValueDisplay: 'Medium' },
      { key: 'PROJ-3', summary: 'Refactor service', currentValueDisplay: '—' },
    ];
    const table = buildBulkUpdateReviewTable(rows);
    expect(table).toBe(
      '| Key | Summary | Current value |\n' +
      '| --- | --- | --- |\n' +
      '| PROJ-1 | Fix login bug | High |\n' +
      '| PROJ-2 | Update docs | Medium |\n' +
      '| PROJ-3 | Refactor service | — |'
    );
  });

  it('renders header + separator only when there are no rows', () => {
    expect(buildBulkUpdateReviewTable([])).toBe(
      '| Key | Summary | Current value |\n' +
      '| --- | --- | --- |'
    );
  });
});

describe('rewriteAttachmentLinks', () => {
  const downloaded = new Set(['screenshot.png', 'error.log']);
  const skippedUrls = new Map([['heap-dump.bin', 'https://jira.example.com/att3']]);

  it('rewrites downloaded filename href to attachments/ path', () => {
    const result = rewriteAttachmentLinks(
      '![screenshot.png](screenshot.png)',
      downloaded, skippedUrls,
    );
    expect(result).toBe('![screenshot.png](attachments/screenshot.png)');
  });

  it('rewrites skipped filename href to the Jira content URL', () => {
    const result = rewriteAttachmentLinks(
      '[heap-dump.bin](heap-dump.bin)',
      downloaded, skippedUrls,
    );
    expect(result).toBe('[heap-dump.bin](https://jira.example.com/att3)');
  });

  it('leaves external URL hrefs unchanged', () => {
    const md = '![img](https://example.com/image.png)';
    expect(rewriteAttachmentLinks(md, downloaded, skippedUrls)).toBe(md);
  });

  it('leaves ordinary hyperlinks unchanged', () => {
    const md = '[Jira](https://jira.example.com/browse/PROJ-1)';
    expect(rewriteAttachmentLinks(md, downloaded, skippedUrls)).toBe(md);
  });

  it('rewrites multiple occurrences in a single string', () => {
    const md = '![screenshot.png](screenshot.png) and [error.log](error.log)';
    const result = rewriteAttachmentLinks(md, downloaded, skippedUrls);
    expect(result).toContain('attachments/screenshot.png');
    expect(result).toContain('attachments/error.log');
  });

  it('returns unchanged string when sets are empty', () => {
    const md = '![file.png](file.png)';
    expect(rewriteAttachmentLinks(md, new Set(), new Map())).toBe(md);
  });
});

describe('parseSkippedAttachmentSelection', () => {
  it('returns a single-element array for a valid bare number', () => {
    expect(parseSkippedAttachmentSelection('1', 3)).toEqual([1]);
    expect(parseSkippedAttachmentSelection('3', 3)).toEqual([3]);
  });

  it('trims whitespace before parsing', () => {
    expect(parseSkippedAttachmentSelection('  2  ', 3)).toEqual([2]);
  });

  it('returns out-of-range for a bare digit outside the list', () => {
    expect(parseSkippedAttachmentSelection('0', 3)).toBe('out-of-range');
    expect(parseSkippedAttachmentSelection('4', 3)).toBe('out-of-range');
  });

  it('returns not-a-selection for words without numbers', () => {
    expect(parseSkippedAttachmentSelection('all', 3)).toBe('not-a-selection');
    expect(parseSkippedAttachmentSelection('', 3)).toBe('not-a-selection');
    expect(parseSkippedAttachmentSelection('abc', 3)).toBe('not-a-selection');
  });

  it('returns not-a-selection for a new command prompt', () => {
    expect(parseSkippedAttachmentSelection('write a comment explaining the issue', 3)).toBe('not-a-selection');
  });

  it('returns not-a-selection for a ticket key (letters mixed with digits)', () => {
    expect(parseSkippedAttachmentSelection('PROJ-123', 3)).toBe('not-a-selection');
  });

  it('accepts "download N" prefix for a single file', () => {
    expect(parseSkippedAttachmentSelection('download 1', 3)).toEqual([1]);
    expect(parseSkippedAttachmentSelection('Download 2', 3)).toEqual([2]);
  });

  it('accepts space-separated indices for multi-download', () => {
    expect(parseSkippedAttachmentSelection('1 2', 3)).toEqual([1, 2]);
    expect(parseSkippedAttachmentSelection('1 3', 3)).toEqual([1, 3]);
  });

  it('accepts comma-separated indices for multi-download', () => {
    expect(parseSkippedAttachmentSelection('1, 2, 3', 3)).toEqual([1, 2, 3]);
    expect(parseSkippedAttachmentSelection('1,3', 3)).toEqual([1, 3]);
  });

  it('accepts "download N M ..." for multi-download', () => {
    expect(parseSkippedAttachmentSelection('download 1 2 3', 3)).toEqual([1, 2, 3]);
    expect(parseSkippedAttachmentSelection('download 1, 3', 3)).toEqual([1, 3]);
  });

  it('deduplicates repeated indices', () => {
    expect(parseSkippedAttachmentSelection('1 1 2', 3)).toEqual([1, 2]);
  });

  it('returns out-of-range when any index in a multi-selection is out of range', () => {
    expect(parseSkippedAttachmentSelection('1 4', 3)).toBe('out-of-range');
    expect(parseSkippedAttachmentSelection('download 2 5', 3)).toBe('out-of-range');
  });
});

describe('pickEmailOption', () => {
  const TEMPLATES = [
    { name: 'Bug Report', issueType: 'Bug' },
    { name: 'Feature Request', issueType: 'Story' },
  ];
  const TYPES = ['Bug', 'Story', 'Task'];

  it('returns template pick for n within template range', () => {
    expect(pickEmailOption(1, TEMPLATES, TYPES)).toEqual({ kind: 'template', name: 'Bug Report', issueType: 'Bug' });
    expect(pickEmailOption(2, TEMPLATES, TYPES)).toEqual({ kind: 'template', name: 'Feature Request', issueType: 'Story' });
  });

  it('returns type pick for n beyond template range', () => {
    expect(pickEmailOption(3, TEMPLATES, TYPES)).toEqual({ kind: 'type', issueType: 'Bug' });
    expect(pickEmailOption(4, TEMPLATES, TYPES)).toEqual({ kind: 'type', issueType: 'Story' });
    expect(pickEmailOption(5, TEMPLATES, TYPES)).toEqual({ kind: 'type', issueType: 'Task' });
  });

  it('returns null for n below range', () => {
    expect(pickEmailOption(0, TEMPLATES, TYPES)).toBeNull();
  });

  it('returns null for n above total range', () => {
    expect(pickEmailOption(6, TEMPLATES, TYPES)).toBeNull();
  });

  it('works with templates only (no types)', () => {
    expect(pickEmailOption(1, TEMPLATES, [])).toEqual({ kind: 'template', name: 'Bug Report', issueType: 'Bug' });
    expect(pickEmailOption(2, TEMPLATES, [])).toEqual({ kind: 'template', name: 'Feature Request', issueType: 'Story' });
    expect(pickEmailOption(3, TEMPLATES, [])).toBeNull();
  });

  it('works with types only (no templates)', () => {
    expect(pickEmailOption(1, [], TYPES)).toEqual({ kind: 'type', issueType: 'Bug' });
    expect(pickEmailOption(3, [], TYPES)).toEqual({ kind: 'type', issueType: 'Task' });
    expect(pickEmailOption(4, [], TYPES)).toBeNull();
  });

  it('returns null for both lists empty', () => {
    expect(pickEmailOption(1, [], [])).toBeNull();
  });
});

describe('selectDefaultIssueType', () => {
  it('prefers Story when present', () => {
    expect(selectDefaultIssueType(['Bug', 'Story', 'Task'])).toBe('Story');
  });

  it('falls back to Task when no Story', () => {
    expect(selectDefaultIssueType(['Bug', 'Task'])).toBe('Task');
  });

  it('falls back to first type when neither Story nor Task', () => {
    expect(selectDefaultIssueType(['Epic', 'Bug'])).toBe('Epic');
  });

  it('returns literal "Story" when list is empty', () => {
    expect(selectDefaultIssueType([])).toBe('Story');
  });
});

describe('isPointerPrompt', () => {
  it('matches "post it"', () => {
    expect(isPointerPrompt('post it')).toBe(true);
  });

  it('matches "use this as a comment on PROJ-123"', () => {
    expect(isPointerPrompt('use this as a comment on PROJ-123')).toBe(true);
  });

  it('matches "add that as a comment"', () => {
    expect(isPointerPrompt('add that as a comment')).toBe(true);
  });

  it('does not match a standalone generation instruction', () => {
    expect(isPointerPrompt('write a summary of the investigation findings')).toBe(false);
  });

  it('does not match a literal comment instruction', () => {
    expect(isPointerPrompt('add comment: everything looks good')).toBe(false);
  });

  it('does not match "use this approach"', () => {
    expect(isPointerPrompt('use this approach when fixing the bug')).toBe(false);
  });

  it('does not match "take this into account"', () => {
    expect(isPointerPrompt('take this into account')).toBe(false);
  });
});

describe('buildTeamJql', () => {
  it('wraps team JQL and appends resolution is NULL when no extra conditions given', () => {
    const result = buildTeamJql('project = BACKEND', null);
    expect(result).toBe('(project = BACKEND) AND resolution is NULL');
  });

  it('ANDs extra conditions when the LLM also produced filter clauses', () => {
    const result = buildTeamJql('project = BACKEND', 'issuetype = Bug AND resolution is NULL');
    expect(result).toBe('(project = BACKEND) AND (issuetype = Bug AND resolution is NULL)');
  });

  it('preserves complex team JQL containing AND without double-wrapping', () => {
    const teamJql = 'project = BACKEND AND assignee in membersOf("backend-team")';
    const result = buildTeamJql(teamJql, null);
    expect(result).toBe('(project = BACKEND AND assignee in membersOf("backend-team")) AND resolution is NULL');
  });

  it('uses extra JQL as-is when provided, not falling back to resolution is NULL', () => {
    const result = buildTeamJql('project = PROJ', 'resolution is not NULL');
    expect(result).not.toContain('resolution is NULL AND');
    expect(result).toBe('(project = PROJ) AND (resolution is not NULL)');
  });
});

const sampleRows: VeracodeReviewRow[] = [
  {
    id: 'A1', issueId: '10102', severity: 4, severityLabelText: 'High', cweId: '798',
    summary: '10102 - ExampleFtpClient.java:41 - Credentials Management',
    labels: ['veracode', 'veracode-issue-10102', 'cwe-798'], descriptionWiki: 'h3. Severity\nHigh (4)',
    existingTicketKey: 'PROJ-501', included: false,
  },
  {
    id: '1', issueId: '10101', severity: 5, severityLabelText: 'Very High', cweId: '89',
    summary: '10101 - ExampleOrderDao.java:88 - SQL Injection',
    labels: ['veracode', 'veracode-issue-10101', 'cwe-89'], descriptionWiki: 'h3. Severity\nVery High (5)',
    existingTicketKey: null, included: true,
  },
  {
    id: '2', issueId: '10103', severity: 4, severityLabelText: 'High', cweId: '798',
    summary: '10103 - ExampleApp.war - Credentials Management',
    labels: ['veracode', 'veracode-issue-10103', 'cwe-798'], descriptionWiki: 'h3. Severity\nHigh (4)',
    existingTicketKey: null, included: true,
  },
];

describe('buildImportReviewTable — Veracode config', () => {
  it('renders an "Already ticketed" section and a "New — will create" section', () => {
    const table = buildImportReviewTable(sampleRows, 'https://jira.example.com', undefined, VERACODE_REVIEW_COLUMNS, 'flaw(s)');
    expect(table).toContain('### Already ticketed');
    expect(table).toContain('[PROJ-501](https://jira.example.com/browse/PROJ-501)');
    expect(table).toContain('### New — will create');
    expect(table).toContain('10101 - ExampleOrderDao.java:88 - SQL Injection');
    expect(table).toContain('**2** ticket(s) will be created.');
  });

  it('omits the "Already ticketed" section entirely when there are no dupes', () => {
    const onlyNew = sampleRows.filter(r => r.existingTicketKey === null);
    const table = buildImportReviewTable(onlyNew, undefined, undefined, VERACODE_REVIEW_COLUMNS, 'flaw(s)');
    expect(table).not.toContain('Already ticketed');
  });

  it('renders plain ticket key (no link) when baseUrl is not provided', () => {
    const table = buildImportReviewTable(sampleRows, undefined, undefined, VERACODE_REVIEW_COLUMNS, 'flaw(s)');
    expect(table).toContain('| A1 |');
    expect(table).toContain('PROJ-501');
    expect(table).not.toContain('](');
  });
});

describe('parseReviewInput — Veracode ids', () => {
  const ids = ['A1', '1', '2'];

  it('recognizes ok and cancel', () => {
    expect(parseReviewInput('ok', ids)).toEqual({ action: 'ok' });
    expect(parseReviewInput('c', ids)).toEqual({ action: 'cancel' });
    expect(parseReviewInput('cancel', ids)).toEqual({ action: 'cancel' });
  });

  it('toggles a single new-row id (excludes a default-included row)', () => {
    expect(parseReviewInput('2', ids)).toEqual({ action: 'toggle', ids: ['2'] });
  });

  it('toggles an already-ticketed row id (forces re-creation)', () => {
    expect(parseReviewInput('A1', ids)).toEqual({ action: 'toggle', ids: ['A1'] });
  });

  it('toggles multiple ids at once, case-insensitively', () => {
    expect(parseReviewInput('a1 2', ids)).toEqual({ action: 'toggle', ids: ['A1', '2'] });
  });

  it('returns invalid for unrecognized ids or empty input', () => {
    expect(parseReviewInput('99', ids)).toEqual({ action: 'invalid' });
    expect(parseReviewInput('', ids)).toEqual({ action: 'invalid' });
  });

  it('also recognizes other shared confirmation/cancellation words, not just ok/c/cancel', () => {
    expect(parseReviewInput('yes', ids)).toEqual({ action: 'ok' });
    expect(parseReviewInput('stop', ids)).toEqual({ action: 'cancel' });
  });
});

describe('applyReviewToggle — Veracode rows', () => {
  it('flips included for the given row ids and leaves the rest untouched', () => {
    const toggled = applyReviewToggle(sampleRows, ['2']);
    expect(toggled.find(r => r.id === '2')!.included).toBe(false);
    expect(toggled.find(r => r.id === '1')!.included).toBe(true);
  });

  it('flips an already-ticketed row back to included (force re-create)', () => {
    const toggled = applyReviewToggle(sampleRows, ['A1']);
    expect(toggled.find(r => r.id === 'A1')!.included).toBe(true);
  });

  it('toggles multiple ids at once', () => {
    const toggled = applyReviewToggle(sampleRows, ['1', '2']);
    expect(toggled.find(r => r.id === '1')!.included).toBe(false);
    expect(toggled.find(r => r.id === '2')!.included).toBe(false);
  });

  it('returns new row objects rather than mutating the input (pure function)', () => {
    const toggled = applyReviewToggle(sampleRows, ['1']);
    expect(toggled).not.toBe(sampleRows);
    expect(sampleRows.find(r => r.id === '1')!.included).toBe(true); // original array/objects untouched
  });
});

const sampleWaltzRows: WaltzReviewRow[] = [
  {
    id: 'A1',
    nameVersion: 'example-lib:1.2.3',
    maxVulnRating: 'Critical',
    summary: '[OSS] example-lib:1.2.3 — Critical',
    labels: ['oss-dependency', 'oss-dep-example-lib-1-2-3'],
    descriptionWiki: 'h3. Max Vuln Rating\nCritical',
    existingTicketKey: 'PROJ-1',
    included: false,
  },
  {
    id: '1',
    nameVersion: 'example-io:4.5.0',
    maxVulnRating: 'High',
    summary: '[OSS] example-io:4.5.0 — High',
    labels: ['oss-dependency', 'oss-dep-example-io-4-5-0'],
    descriptionWiki: 'h3. Max Vuln Rating\nHigh',
    existingTicketKey: null,
    included: true,
  },
];

describe('buildImportReviewTable — Waltz config', () => {
  it('splits already-ticketed rows from new rows into separate tables', () => {
    const table = buildImportReviewTable(sampleWaltzRows, undefined, undefined, WALTZ_REVIEW_COLUMNS, 'component(s)');
    expect(table).toContain('### Already ticketed');
    expect(table).toContain('PROJ-1');
    expect(table).toContain('### New — will create');
    expect(table).toContain('example-io:4.5.0');
    expect(table).toContain('**1** ticket(s) will be created.');
  });

  it('links the existing ticket key when a baseUrl is provided', () => {
    const table = buildImportReviewTable(sampleWaltzRows, 'https://jira.example.com', undefined, WALTZ_REVIEW_COLUMNS, 'component(s)');
    expect(table).toContain('[PROJ-1](https://jira.example.com/browse/PROJ-1)');
  });

  it('shows an explanatory line instead of an empty table when every match already has a ticket', () => {
    const allTicketed = sampleWaltzRows.filter(r => r.existingTicketKey !== null);
    const table = buildImportReviewTable(allTicketed, undefined, undefined, WALTZ_REVIEW_COLUMNS, 'component(s)');
    expect(table).toContain('### New — will create');
    expect(table).toContain('_All matching components already have a ticket._');
    expect(table).not.toContain('| # | Component | Rating | Include? |');
  });

  it('notes when more new components matched than the BATCH_LIMIT-capped rows shown, and how to get the rest', () => {
    // 75 matched, only 1 "new" row present in sampleWaltzRows
    const table = buildImportReviewTable(sampleWaltzRows, undefined, 75, WALTZ_REVIEW_COLUMNS, 'component(s)');
    expect(table).toContain('74 more matched component(s) not shown');
    expect(table).toContain('re-run the import after this batch completes');
  });

  it('omits the truncation note when totalNewMatched is not given or matches what is shown', () => {
    expect(buildImportReviewTable(sampleWaltzRows, undefined, undefined, WALTZ_REVIEW_COLUMNS, 'component(s)'))
      .not.toContain('more matched component(s) not shown');
    expect(buildImportReviewTable(sampleWaltzRows, undefined, 1, WALTZ_REVIEW_COLUMNS, 'component(s)'))
      .not.toContain('more matched component(s) not shown');
  });

  it('warns on the review screen itself when included rows exceed BATCH_LIMIT, not just in the completion summary', () => {
    const manyIncluded: WaltzReviewRow[] = Array.from({ length: 51 }, (_, i) => ({
      id: `${i + 1}`,
      nameVersion: `example-pkg-${i}:1.0.0`,
      maxVulnRating: 'High',
      summary: `[OSS] example-pkg-${i}:1.0.0 — High`,
      labels: ['oss-dependency'],
      descriptionWiki: '',
      existingTicketKey: null,
      included: true,
    }));
    const table = buildImportReviewTable(manyIncluded, undefined, undefined, WALTZ_REVIEW_COLUMNS, 'component(s)');
    expect(table).toContain('Only the first 50');
  });
});

describe('parseReviewInput — Waltz ids', () => {
  it('recognizes ok/cancel and toggle-id lists', () => {
    expect(parseReviewInput('ok', ['A1', '1'])).toEqual({ action: 'ok' });
    expect(parseReviewInput('c', ['A1', '1'])).toEqual({ action: 'cancel' });
    expect(parseReviewInput('A1 1', ['A1', '1'])).toEqual({ action: 'toggle', ids: ['A1', '1'] });
    expect(parseReviewInput('nonsense', ['A1', '1'])).toEqual({ action: 'invalid' });
  });

  it('matches ids case-insensitively', () => {
    expect(parseReviewInput('a1 1', ['A1', '1'])).toEqual({ action: 'toggle', ids: ['A1', '1'] });
  });

  it('returns invalid for empty input', () => {
    expect(parseReviewInput('', ['A1', '1'])).toEqual({ action: 'invalid' });
  });
});

describe('applyReviewToggle — Waltz rows', () => {
  it('flips included for the matching row ids only', () => {
    const toggled = applyReviewToggle(sampleWaltzRows, ['1']);
    expect(toggled.find(r => r.id === '1')!.included).toBe(false);
    expect(toggled.find(r => r.id === 'A1')!.included).toBe(false); // unchanged
  });

  it('flips an already-ticketed row back to included (force re-create)', () => {
    const toggled = applyReviewToggle(sampleWaltzRows, ['A1']);
    expect(toggled.find(r => r.id === 'A1')!.included).toBe(true);
    expect(toggled.find(r => r.id === '1')!.included).toBe(true); // unchanged
  });
});

describe('isSessionExpired (schemaVersion shape guard — AE7)', () => {
  it('treats a session with no schemaVersion (pre-consolidation) as expired', () => {
    expect(isSessionExpired({})).toBe(true);
  });

  it('treats a session with a lower schemaVersion than current as expired', () => {
    expect(isSessionExpired({ schemaVersion: CURRENT_SESSION_SCHEMA_VERSION - 1 })).toBe(true);
  });

  it('treats a session with the current schemaVersion as not expired', () => {
    expect(isSessionExpired({ schemaVersion: CURRENT_SESSION_SCHEMA_VERSION })).toBe(false);
  });

  it('does not flag "no session at all" as expired — that is a different, already-handled case', () => {
    expect(isSessionExpired(undefined)).toBe(false);
    expect(isSessionExpired(null)).toBe(false);
  });

  it('exposes a user-facing message that tells the user to re-run the import', () => {
    expect(SESSION_EXPIRED_MESSAGE.toLowerCase()).toContain('re-run the import');
  });
});
