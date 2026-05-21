import { describe, it, expect } from 'vitest';
import { extractCreatedKeyFromConfirmation, extractLastTicketFromText, isConfirmation, isCancellation, serializeTurns, stripHiddenMarkers, parseTemplateSelection, parseIssueTypeSelection, parseSkipInput, parseResolutionSelection, parseCommentIndex, buildCommentListSession, formatCommentsInFull, parseFilterSelection, parseBulkUpdateReview, rewriteAttachmentLinks } from '../participant/sessionState';
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

  it('returns only the last 3 turns in recent mode', () => {
    const result = serializeTurns(turns, 'recent');
    expect(result).not.toContain('Show me PROJ-1');
    expect(result).toContain('Write a poem about it');
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
});

describe('extractCreatedKeyFromConfirmation', () => {
  it('extracts key from a standard creation confirmation', () => {
    expect(extractCreatedKeyFromConfirmation('Created PROJ-125: **Login timeout bug** (Bug in PROJ)')).toBe('PROJ-125');
  });

  it('extracts key with multi-segment project name', () => {
    expect(extractCreatedKeyFromConfirmation('Created VSJI-42: **Add dark mode** (Story in VSJI)')).toBe('VSJI-42');
  });

  it('returns null when no ticket key is present', () => {
    expect(extractCreatedKeyFromConfirmation('Cancelled.')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(extractCreatedKeyFromConfirmation('')).toBeNull();
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


describe('parseTemplateSelection', () => {
  const templates = ['User Story for Ticket Sidekick', 'Bug Report', 'Task'];

  it('selects by 1-based number', () => {
    expect(parseTemplateSelection('1', templates)).toBe('User Story for Ticket Sidekick');
    expect(parseTemplateSelection('2', templates)).toBe('Bug Report');
    expect(parseTemplateSelection('3', templates)).toBe('Task');
  });

  it('selects by exact name (case-insensitive)', () => {
    expect(parseTemplateSelection('Bug Report', templates)).toBe('Bug Report');
    expect(parseTemplateSelection('bug report', templates)).toBe('Bug Report');
    expect(parseTemplateSelection('BUG REPORT', templates)).toBe('Bug Report');
  });

  it('returns null for no-template phrases including (n) shortcut', () => {
    expect(parseTemplateSelection('n', templates)).toBeNull();
    expect(parseTemplateSelection('no template', templates)).toBeNull();
    expect(parseTemplateSelection('none', templates)).toBeNull();
    expect(parseTemplateSelection('skip', templates)).toBeNull();
    expect(parseTemplateSelection('0', templates)).toBeNull();
    expect(parseTemplateSelection('no', templates)).toBeNull();
  });

  it('returns cancel for (c) shortcut and "cancel"', () => {
    expect(parseTemplateSelection('c', templates)).toBe('cancel');
    expect(parseTemplateSelection('cancel', templates)).toBe('cancel');
    expect(parseTemplateSelection('C', templates)).toBe('cancel');
    expect(parseTemplateSelection('Cancel', templates)).toBe('cancel');
  });

  it('returns invalid for out-of-range number', () => {
    expect(parseTemplateSelection('4', templates)).toBe('invalid');
    expect(parseTemplateSelection('0', templates)).toBeNull();
  });

  it('returns invalid for unrecognised text', () => {
    expect(parseTemplateSelection('something else', templates)).toBe('invalid');
    expect(parseTemplateSelection('', templates)).toBe('invalid');
  });

  it('trims whitespace before matching', () => {
    expect(parseTemplateSelection('  2  ', templates)).toBe('Bug Report');
    expect(parseTemplateSelection('  no template  ', templates)).toBeNull();
  });
});

describe('parseIssueTypeSelection', () => {
  const types = ['Bug', 'Story', 'Task'];

  it('selects by 1-based number', () => {
    expect(parseIssueTypeSelection('1', types)).toBe('Bug');
    expect(parseIssueTypeSelection('2', types)).toBe('Story');
    expect(parseIssueTypeSelection('3', types)).toBe('Task');
  });

  it('selects by exact name (case-insensitive)', () => {
    expect(parseIssueTypeSelection('Bug', types)).toBe('Bug');
    expect(parseIssueTypeSelection('bug', types)).toBe('Bug');
    expect(parseIssueTypeSelection('STORY', types)).toBe('Story');
  });

  it('returns cancel for (c) shortcut and "cancel"', () => {
    expect(parseIssueTypeSelection('c', types)).toBe('cancel');
    expect(parseIssueTypeSelection('cancel', types)).toBe('cancel');
    expect(parseIssueTypeSelection('C', types)).toBe('cancel');
    expect(parseIssueTypeSelection('Cancel', types)).toBe('cancel');
  });

  it('returns invalid for out-of-range number', () => {
    expect(parseIssueTypeSelection('4', types)).toBe('invalid');
    expect(parseIssueTypeSelection('0', types)).toBe('invalid');
  });

  it('returns invalid for unrecognised text', () => {
    expect(parseIssueTypeSelection('something', types)).toBe('invalid');
    expect(parseIssueTypeSelection('', types)).toBe('invalid');
  });

  it('trims whitespace before matching', () => {
    expect(parseIssueTypeSelection('  2  ', types)).toBe('Story');
    expect(parseIssueTypeSelection('  bug  ', types)).toBe('Bug');
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
