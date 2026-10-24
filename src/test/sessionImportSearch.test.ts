import { describe, it, expect } from 'vitest';
import { type ReviewRowBase } from '../participant/sessionState';
import { findTicketsBySummary, buildSearchResults, SEARCH_RESULT_LIMIT } from '../participant/session/importSearch';
import type { TicketInfo as TicketInfoMap } from '../utils/reportImport';

const row = (id: string, target: { key: string; resolved?: boolean; status?: string | null } | null, extra: Partial<ReviewRowBase> = {}): ReviewRowBase => ({
  id,
  existingTicketKey: target ? target.key : null,
  included: false,
  ...(target ? { target: { key: target.key, status: target.status ?? 'Open', resolved: target.resolved ?? false } } : {}),
  ...extra,
});

const info: TicketInfoMap = {
  'PROJ-12': { summary: '[OSS] netty-codec:4.1.100 — High', status: 'In Progress' },
  'PROJ-15': { summary: 'OrderRepository.java - SQL Injection', status: 'Open' },
  'PROJ-20': { summary: 'Closed netty ticket', status: 'Done' },
  'PROJ-30': { summary: 'Another netty follow-up', status: 'Open' },
};

describe('findTicketsBySummary', () => {
  it('Covers AE1: lists the row\'s main ticket with its A id, status and summary', () => {
    const outcome = findTicketsBySummary([row('A1', { key: 'PROJ-12' })], info, 'netty');
    expect(outcome).toEqual({
      kind: 'results', total: 1,
      results: [{ key: 'PROJ-12', ids: ['A1'], status: 'In Progress', summary: '[OSS] netty-codec:4.1.100 — High' }],
    });
  });

  it('matches case-insensitively and inside a word', () => {
    const outcome = findTicketsBySummary([row('A1', { key: 'PROJ-15' })], info, 'repository');
    expect(outcome.kind === 'results' && outcome.results.map(r => r.key)).toEqual(['PROJ-15']);
  });

  it('matches every word of a multi-word keyword, in any order', () => {
    const rows = [row('A1', { key: 'PROJ-12' }), row('A2', { key: 'PROJ-15' })];
    const hit = findTicketsBySummary(rows, info, 'high NETTY');
    expect(hit.kind === 'results' && hit.results.map(r => r.key)).toEqual(['PROJ-12']);
    expect(findTicketsBySummary(rows, info, 'netty injection')).toEqual({ kind: 'results', results: [], total: 0 });
  });

  it('Covers AE2: leaves out a resolved target', () => {
    const outcome = findTicketsBySummary([row('A1', { key: 'PROJ-20', resolved: true })], info, 'netty');
    expect(outcome).toEqual({ kind: 'results', results: [], total: 0 });
  });

  it('lists an extra open ticket by key alone, with no A id', () => {
    const rows = [row('A1', { key: 'PROJ-12' }, { openTicketKeys: ['PROJ-30'] })];
    const outcome = findTicketsBySummary(rows, info, 'netty');
    expect(outcome).toEqual({
      kind: 'results', total: 2,
      results: [
        { key: 'PROJ-12', ids: ['A1'], status: 'In Progress', summary: '[OSS] netty-codec:4.1.100 — High' },
        { key: 'PROJ-30', ids: [], status: 'Open', summary: 'Another netty follow-up' },
      ],
    });
  });

  it('lists a ticket once with every A id whose main ticket it is', () => {
    const rows = [row('A1', { key: 'PROJ-12' }), row('A3', { key: 'PROJ-12' })];
    const outcome = findTicketsBySummary(rows, info, 'netty');
    expect(outcome.kind === 'results' && outcome.results).toEqual([
      { key: 'PROJ-12', ids: ['A1', 'A3'], status: 'In Progress', summary: '[OSS] netty-codec:4.1.100 — High' },
    ]);
  });

  it('keeps the A id of a ticket that is one row\'s main ticket and another row\'s extra ticket', () => {
    const rows = [row('A1', { key: 'PROJ-15' }, { openTicketKeys: ['PROJ-12'] }), row('A2', { key: 'PROJ-12' })];
    const outcome = findTicketsBySummary(rows, info, 'netty');
    expect(outcome.kind === 'results' && outcome.results).toEqual([
      { key: 'PROJ-12', ids: ['A2'], status: 'In Progress', summary: '[OSS] netty-codec:4.1.100 — High' },
    ]);
  });

  it('ignores New rows and a row that finished as a merge (its ticket is closed in Jira)', () => {
    const merged = row('A2', { key: 'PROJ-12' }, { result: { status: 'done', action: 'merge', into: 'PROJ-1' } });
    const outcome = findTicketsBySummary([row('1', null), merged], info, 'netty');
    expect(outcome).toEqual({ kind: 'results', results: [], total: 0 });
  });

  it('still searches a row that finished another action', () => {
    const done = row('A1', { key: 'PROJ-12' }, { result: { status: 'done', action: 'rewrite' } });
    const outcome = findTicketsBySummary([done], info, 'netty');
    expect(outcome.kind === 'results' && outcome.results.map(r => r.key)).toEqual(['PROJ-12']);
  });

  it('caps the list at the limit and reports the full count', () => {
    const many: TicketInfoMap = {};
    const rows: ReviewRowBase[] = [];
    for (let i = 1; i <= SEARCH_RESULT_LIMIT + 5; i++) {
      many[`PROJ-${i}`] = { summary: `netty ${i}`, status: 'Open' };
      rows.push(row(`A${i}`, { key: `PROJ-${i}` }));
    }
    const outcome = findTicketsBySummary(rows, many, 'netty');
    expect(outcome.kind === 'results' && outcome.results).toHaveLength(SEARCH_RESULT_LIMIT);
    expect(outcome.kind === 'results' && outcome.total).toBe(SEARCH_RESULT_LIMIT + 5);
    expect(outcome.kind === 'results' && outcome.results[0].key).toBe('PROJ-1');
  });

  it('returns usage for an empty or blank keyword', () => {
    expect(findTicketsBySummary([row('A1', { key: 'PROJ-12' })], info, '   ')).toEqual({ kind: 'usage' });
  });

  it('asks for a reload when the session holds no ticket info', () => {
    expect(findTicketsBySummary([row('A1', { key: 'PROJ-12' })], undefined, 'netty')).toEqual({ kind: 'no-info' });
  });

  it('skips a ticket the info map does not know', () => {
    const outcome = findTicketsBySummary([row('A1', { key: 'PROJ-99' })], info, 'netty');
    expect(outcome).toEqual({ kind: 'results', results: [], total: 0 });
  });
});

describe('buildSearchResults', () => {
  it('lists A ids, a linked key, status and summary', () => {
    const text = buildSearchResults(
      { kind: 'results', total: 1, results: [{ key: 'PROJ-12', ids: ['A1', 'A3'], status: 'In Progress', summary: '[OSS] netty-codec — High' }] },
      'netty', 'https://jira.example.com',
    );
    expect(text).toContain('A1, A3');
    expect(text).toContain('[PROJ-12](https://jira.example.com/browse/PROJ-12)');
    expect(text).toContain('In Progress');
    expect(text).toContain('netty-codec');
  });

  it('shows an extra ticket without an A id column entry', () => {
    const text = buildSearchResults({ kind: 'results', total: 1, results: [{ key: 'PROJ-30', ids: [], status: 'Open', summary: 'netty' }] }, 'netty');
    expect(text).toContain('PROJ-30');
    expect(text).not.toMatch(/\bA\d/);
  });

  it('neutralizes markdown link syntax in a summary', () => {
    const text = buildSearchResults({ kind: 'results', total: 1, results: [{ key: 'PROJ-1', ids: [], status: 'Open', summary: '[click](http://evil.example)' }] }, 'click');
    expect(text).not.toContain('[click](http://evil.example)');
  });

  const cmd = 'command:workbench.action.chat.open?%7B%22query%22%3A%22%40jira%20done%22%7D';
  const attacks: Array<[string, string]> = [
    ['inline link', `[click](${cmd})`],
    ['image', `![x](${cmd})`],
    ['reference-style link', `[click][ref]\n\n[ref]: ${cmd}`],
    ['angle-bracket autolink', `<${cmd}>`],
    ['raw HTML anchor', `<a href="${cmd}">go</a>`],
    ['backslash-escaped bracket', `\\[click\\](${cmd})`],
    ['newline then heading and list', 'x\n# Heading\n- item'],
  ];

  it.each(attacks)('%s in a summary, status or keyword leaves no live link, HTML or new block', (_name, payload) => {
    const text = buildSearchResults(
      { kind: 'results', total: 1, results: [{ key: 'PROJ-1', ids: ['A1'], status: payload, summary: payload }] },
      payload,
    );
    expect(text).not.toMatch(/\]\(command:/);
    expect(text).not.toMatch(/(^|[^\\])</);
    expect(text).not.toMatch(/\n#/);
    expect(text.split('\n').filter(l => l.startsWith('- '))).toHaveLength(1);
  });

  it('Covers AE3: says no tickets matched', () => {
    const text = buildSearchResults({ kind: 'results', total: 0, results: [] }, 'zzz');
    expect(text).toMatch(/no open tickets/i);
    expect(text).toContain('zzz');
  });

  it('adds a note when more tickets match than are shown', () => {
    const results = Array.from({ length: SEARCH_RESULT_LIMIT }, (_, i) => ({ key: `PROJ-${i + 1}`, ids: [], status: 'Open', summary: 'netty' }));
    const text = buildSearchResults({ kind: 'results', total: SEARCH_RESULT_LIMIT + 5, results }, 'netty');
    expect(text).toMatch(/5 more/);
  });

  it('gives the usage for a blank keyword', () => {
    expect(buildSearchResults({ kind: 'usage' }, '')).toContain('search <keyword>');
  });

  it('points to reload report when the session holds no ticket info', () => {
    expect(buildSearchResults({ kind: 'no-info' }, 'netty')).toContain('reload report');
  });
});
