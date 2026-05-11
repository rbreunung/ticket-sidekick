import { describe, it, expect } from 'vitest';
import { extractCreatedKeyFromConfirmation, extractLastTicketFromText, isConfirmation, isCancellation, serializeTurns, stripHiddenMarkers, parseTemplateSelection, parseIssueTypeSelection, parseSkipInput, parseResolutionSelection } from '../participant/sessionState';
import type { TransitionBatchTicket } from '../participant/sessionState';

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
