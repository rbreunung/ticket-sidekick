import { describe, it, expect } from 'vitest';
import {
  decideTicketStep,
  buildTicketPause,
  buildSmartRerunCommand,
  buildTicketHintLine,
  buildTicketFailureLine,
} from '../participant/bitbucket/requirementsFlow';

const base = { explicitKey: undefined, skipTicket: false, titleKey: undefined, jiraConfigured: true } as const;

describe('decideTicketStep', () => {
  it('asks in smart and deep when the title has a key and Jira is configured', () => {
    expect(decideTicketStep({ ...base, mode: 'smart', titleKey: 'PROJ-123' })).toEqual({ kind: 'ask', key: 'PROJ-123' });
    expect(decideTicketStep({ ...base, mode: 'deep', titleKey: 'PROJ-123' })).toEqual({ kind: 'ask', key: 'PROJ-123' });
  });

  it('uses an explicit key without asking, and prefers it over the title key', () => {
    expect(decideTicketStep({ ...base, mode: 'smart', explicitKey: 'PROJ-9', titleKey: 'PROJ-123' })).toEqual({ kind: 'run', key: 'PROJ-9' });
  });

  it('skips on "no ticket" in every mode, even with keys present', () => {
    for (const mode of ['quick', 'standard', 'smart', 'deep'] as const) {
      expect(decideTicketStep({ ...base, mode, skipTicket: true, explicitKey: undefined, titleKey: 'PROJ-1' })).toEqual({ kind: 'skip' });
    }
  });

  it('only hints in quick and standard, and only when Jira is configured', () => {
    expect(decideTicketStep({ ...base, mode: 'standard', titleKey: 'PROJ-123' })).toEqual({ kind: 'hint', key: 'PROJ-123' });
    expect(decideTicketStep({ ...base, mode: 'quick', titleKey: 'PROJ-123' })).toEqual({ kind: 'hint', key: 'PROJ-123' });
    expect(decideTicketStep({ ...base, mode: 'standard', titleKey: 'PROJ-123', jiraConfigured: false })).toEqual({ kind: 'none' });
    expect(decideTicketStep({ ...base, mode: 'standard' })).toEqual({ kind: 'none' });
  });

  it('ignores an explicit key in quick and standard', () => {
    expect(decideTicketStep({ ...base, mode: 'quick', explicitKey: 'PROJ-9' })).toEqual({ kind: 'ignored-explicit', key: 'PROJ-9' });
  });

  it('says Jira is not configured when smart or deep has a key but no Jira', () => {
    expect(decideTicketStep({ ...base, mode: 'smart', titleKey: 'PROJ-123', jiraConfigured: false })).toEqual({ kind: 'not-configured', key: 'PROJ-123' });
    expect(decideTicketStep({ ...base, mode: 'deep', explicitKey: 'PROJ-9', jiraConfigured: false })).toEqual({ kind: 'not-configured', key: 'PROJ-9' });
  });

  it('says there is no key when smart or deep finds none', () => {
    expect(decideTicketStep({ ...base, mode: 'smart' })).toEqual({ kind: 'no-key' });
  });
});

describe('ticket lines and commands', () => {
  const URL = 'https://bb.example.com/projects/PROJ/repos/repo/pull-requests/42';

  it('builds a pause whose two links re-run the original prompt with the key, or with "no ticket"', () => {
    const pause = buildTicketPause('PROJ-123', `review smart ${URL}`);
    const queries = [...pause.matchAll(/command:workbench\.action\.chat\.open\?([^)]+)\)/g)]
      .map((m) => (JSON.parse(decodeURIComponent(m[1])) as { query: string }).query);
    expect(queries).toEqual([`@bitbucket review smart ${URL} PROJ-123`, `@bitbucket review smart ${URL} no ticket`]);
    expect(pause).toContain('PROJ-123');
  });

  it('shows the exact smart re-run command in the hint', () => {
    expect(buildSmartRerunCommand(URL, 'PROJ-123')).toBe(`review smart ${URL} PROJ-123`);
    expect(buildTicketHintLine('PROJ-123', URL)).toContain(`review smart ${URL} PROJ-123`);
  });

  it('words each failure on one line', () => {
    expect(buildTicketFailureLine('PROJ-1', { ok: false, reason: 'not-found', message: 'x' })).toContain('not found');
    expect(buildTicketFailureLine('PROJ-1', { ok: false, reason: 'auth', message: 'x' })).toContain('credentials');
    const other = buildTicketFailureLine('PROJ-1', { ok: false, reason: 'error', message: 'boom\nwith lines' });
    expect(other).toContain('boom with lines');
    expect(other.split('\n')).toHaveLength(1);
  });
});
