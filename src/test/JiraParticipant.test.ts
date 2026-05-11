import { describe, it, expect } from 'vitest';
import { extractCreatedKeyFromConfirmation, extractLastTicketFromText, isConfirmation, isCancellation, serializeTurns, stripHiddenMarkers } from '../participant/sessionState';

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
