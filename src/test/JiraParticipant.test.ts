import { describe, it, expect } from 'vitest';
import { extractCreatedKeyFromConfirmation, extractCreationSessionFromText, extractContentSessionFromText, extractLastTicketFromText, isConfirmation, isCancellation, serializeTurns, stripHiddenMarkers } from '../participant/sessionState';

describe('stripHiddenMarkers', () => {
  it('removes a jira-ticket marker', () => {
    expect(stripHiddenMarkers('Done.\n\n<!-- @jira-ticket:PROJ-1 -->')).toBe('Done.');
  });

  it('removes a jira-create marker', () => {
    const text = 'Next question\n\n<!-- @jira-create:{"template":"X"} -->';
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

describe('extractCreationSessionFromText', () => {
  const validSession = {
    template: 'Billing App Bug',
    project: 'BILLING',
    summary: 'Login bug',
    issueType: 'Bug',
    allSections: ['Steps to reproduce', 'Expected behavior'],
    pending: ['Expected behavior'],
    answers: { 'Steps to reproduce': 'Click login' },
    fields: { priority: 'High' },
  };

  it('extracts session from a response containing the marker', () => {
    const text = `Got it.\n\n<!-- @jira-create:${JSON.stringify(validSession)} -->`;
    const result = extractCreationSessionFromText(text);
    expect(result?.template).toBe('Billing App Bug');
    expect(result?.pending).toEqual(['Expected behavior']);
    expect(result?.answers['Steps to reproduce']).toBe('Click login');
  });

  it('returns null when no marker is present', () => {
    expect(extractCreationSessionFromText('some response with no marker')).toBeNull();
  });

  it('returns null for a marker with malformed JSON', () => {
    expect(extractCreationSessionFromText('<!-- @jira-create:invalid json -->')).toBeNull();
  });

  it('extracts session from text with content before and after marker', () => {
    const text = `**Steps to reproduce** — describe steps\n\n<!-- @jira-create:${JSON.stringify(validSession)} -->\n\nExtra text`;
    const result = extractCreationSessionFromText(text);
    expect(result?.project).toBe('BILLING');
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

describe('extractContentSessionFromText', () => {
  const validSession = {
    ticketKey: 'PROJ-42',
    operation: 'addComment' as const,
    currentContent: 'Here is a comment.',
    historyContext: 'User: what did we find?\n\nAssistant: We found a bug.',
  };

  it('extracts session from a response containing the marker', () => {
    const text = `Preview text\n\n<!-- @jira-content:${JSON.stringify(validSession)} -->`;
    const result = extractContentSessionFromText(text);
    expect(result?.ticketKey).toBe('PROJ-42');
    expect(result?.operation).toBe('addComment');
    expect(result?.currentContent).toBe('Here is a comment.');
  });

  it('returns null when no marker is present', () => {
    expect(extractContentSessionFromText('some response with no marker')).toBeNull();
  });

  it('returns null for a marker with malformed JSON', () => {
    expect(extractContentSessionFromText('<!-- @jira-content:invalid -->')).toBeNull();
  });

  it('preserves undefined historyContext', () => {
    const session = { ...validSession, historyContext: undefined };
    const text = `<!-- @jira-content:${JSON.stringify(session)} -->`;
    const result = extractContentSessionFromText(text);
    expect(result?.historyContext).toBeUndefined();
  });

  it('extracts updateDescription operation', () => {
    const session = { ...validSession, operation: 'updateDescription' as const };
    const text = `<!-- @jira-content:${JSON.stringify(session)} -->`;
    const result = extractContentSessionFromText(text);
    expect(result?.operation).toBe('updateDescription');
  });
});
