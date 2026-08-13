import { describe, it, expect, vi } from 'vitest';
import {
  chunkStrings, buildDedupJql, extractDedupMap, findAlreadyTicketed, capNewRows, buildReviewRows,
  sanitizeCellText, sanitizeStandaloneLine,
  type JqlIssueLike,
} from '../utils/reportImport';

describe('sanitizeCellText', () => {
  it('flattens embedded newlines to a space so a value cannot start a new line the converter re-parses as structure', () => {
    expect(sanitizeCellText('line one\nline two\r\nline three')).toBe('line one line two line three');
  });

  it('replaces a literal pipe so a value cannot split a table cell', () => {
    expect(sanitizeCellText('High | Critical')).toBe('High / Critical');
  });

  it('strips bold/italic/code-span/link trigger characters', () => {
    expect(sanitizeCellText('*bold* _em_ `code` [text](url)')).toBe('bold em code text(url)');
  });

  it('strips tildes so a value cannot render as strikethrough (~~text~~)', () => {
    expect(sanitizeCellText('~~injected~~')).toBe('injected');
  });

  it('neutralizes every trigger character in one crafted payload at once', () => {
    const crafted = 'Injected\n# Fake Heading\n| a | b |\n[click me](http://evil.example) *bold* ~~struck~~';
    const sanitized = sanitizeCellText(crafted);
    expect(sanitized).not.toContain('\n');
    expect(sanitized).not.toContain('|');
    expect(sanitized).not.toMatch(/[*_`[\]~]/);
  });
});

describe('sanitizeStandaloneLine', () => {
  it('prefixes the sanitized value with ": " so it cannot occupy line-start position', () => {
    expect(sanitizeStandaloneLine('Critical')).toBe(': Critical');
  });

  it('prefixes before sanitizing, so a crafted ordered-list/heading/blockquote/horizontal-rule trigger no longer sits at line-start', () => {
    expect(sanitizeStandaloneLine('1. urgent')).toBe(': 1. urgent');
    expect(sanitizeStandaloneLine('---')).toBe(': ---');
    expect(sanitizeStandaloneLine('> quoted')).toBe(': > quoted');
    expect(sanitizeStandaloneLine('# fake heading')).toBe(': # fake heading');
  });

  it('still strips the same trigger characters sanitizeCellText does', () => {
    expect(sanitizeStandaloneLine('~~struck~~ *bold*')).toBe(': struck bold');
  });
});

describe('chunkStrings', () => {
  it('splits an exact multiple of the chunk size into even chunks', () => {
    const items = Array.from({ length: 80 }, (_, i) => String(i));
    const chunks = chunkStrings(items, 40);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(40);
    expect(chunks[1]).toHaveLength(40);
  });

  it('leaves a remainder in the final chunk', () => {
    const items = Array.from({ length: 85 }, (_, i) => String(i));
    const chunks = chunkStrings(items, 40);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(40);
    expect(chunks[1]).toHaveLength(40);
    expect(chunks[2]).toHaveLength(5);
  });

  it('returns a single chunk for a single item', () => {
    expect(chunkStrings(['only-one'], 40)).toEqual([['only-one']]);
  });

  it('returns an empty array for empty input', () => {
    expect(chunkStrings([], 40)).toEqual([]);
  });
});

describe('buildDedupJql', () => {
  it('quotes a numeric-looking label', () => {
    expect(buildDedupJql('PROJ', ['10101', '10103'])).toBe(
      'project = PROJ AND labels in ("10101", "10103")',
    );
  });

  it('quotes a text label', () => {
    expect(buildDedupJql('PROJ', ['oss-dep-example-lib-1-2-3', 'oss-dep-example-io-4-5-0'])).toBe(
      'project = PROJ AND labels in ("oss-dep-example-lib-1-2-3", "oss-dep-example-io-4-5-0")',
    );
  });
});

describe('extractDedupMap', () => {
  const labelToDedupKey = (label: string) => (label.startsWith('oss-dep-') ? label : null);

  it('maps a matched label to the issue key when fields.labels is present', () => {
    const issues: JqlIssueLike[] = [
      { key: 'PROJ-1', fields: { labels: ['oss-dependency', 'oss-dep-example-lib-1-2-3'] } },
      { key: 'PROJ-2', fields: { labels: ['unrelated'] } },
    ];
    const map = extractDedupMap(issues, labelToDedupKey);
    expect(map.get('oss-dep-example-lib-1-2-3')).toBe('PROJ-1');
    expect(map.size).toBe(1);
  });

  it('treats an absent fields.labels as no matches, without throwing', () => {
    const issues: JqlIssueLike[] = [{ key: 'PROJ-3', fields: {} }];
    expect(extractDedupMap(issues, labelToDedupKey).size).toBe(0);
  });

  it('produces no map entry for an issue whose labels never satisfy labelToDedupKey', () => {
    const issues: JqlIssueLike[] = [{ key: 'PROJ-4', fields: { labels: ['random', 'other'] } }];
    expect(extractDedupMap(issues, labelToDedupKey).size).toBe(0);
  });
});

describe('findAlreadyTicketed', () => {
  it('keeps matches from successful chunks when one chunk\'s search rejects, and logs via onDiag instead of throwing (AE2)', async () => {
    const labels = Array.from({ length: 45 }, (_, i) => `label-${i}`); // 2 chunks of size 40/5
    const search = vi
      .fn<(chunk: string[]) => Promise<JqlIssueLike[]>>()
      .mockImplementationOnce(async () => {
        throw new Error('transient network error');
      })
      .mockImplementationOnce(async (chunk) => [
        { key: 'PROJ-9', fields: { labels: [chunk[0]] } },
      ]);
    const onDiag = vi.fn();

    const map = await findAlreadyTicketed(labels, 40, search, (label) => label, onDiag);

    expect(map.get('label-40')).toBe('PROJ-9'); // second chunk's match survived
    expect(map.size).toBe(1); // first (failed) chunk contributed nothing, but didn't wipe the second's result
    expect(onDiag).toHaveBeenCalledTimes(1);
    expect(onDiag).toHaveBeenCalledWith(
      'warn',
      expect.stringContaining('continuing with partial results'),
      expect.objectContaining({ error: expect.stringContaining('transient network error') }),
    );
  });

  it('merges matches across all chunks when every search resolves', async () => {
    const labels = ['a', 'b', 'c'];
    const search = async (chunk: string[]): Promise<JqlIssueLike[]> =>
      chunk.map((label, i) => ({ key: `PROJ-${label}`, fields: { labels: [label] } }));

    const map = await findAlreadyTicketed(labels, 1, search, (label) => label);
    expect(map.get('a')).toBe('PROJ-a');
    expect(map.get('b')).toBe('PROJ-b');
    expect(map.get('c')).toBe('PROJ-c');
  });

  it('returns an empty map without calling search when given no labels', async () => {
    const search = vi.fn();
    const map = await findAlreadyTicketed([], 40, search, (label) => label);
    expect(map.size).toBe(0);
    expect(search).not.toHaveBeenCalled();
  });
});

describe('capNewRows', () => {
  interface Item { key: string; ticketed: boolean }
  const isAlreadyTicketed = (item: Item) => item.ticketed;

  it('does not drop anything when new items are exactly at the limit', () => {
    const items: Item[] = Array.from({ length: 5 }, (_, i) => ({ key: `n${i}`, ticketed: false }));
    const result = capNewRows(items, 5, isAlreadyTicketed);
    expect(result.included).toHaveLength(5);
    expect(result.totalNewMatched).toBe(5);
    expect(result.droppedOverCap).toBe(0);
  });

  it('drops exactly one item when one over the limit, and totalNewMatched reflects the true count', () => {
    const items: Item[] = Array.from({ length: 6 }, (_, i) => ({ key: `n${i}`, ticketed: false }));
    const result = capNewRows(items, 5, isAlreadyTicketed);
    expect(result.included).toHaveLength(5);
    expect(result.totalNewMatched).toBe(6);
    expect(result.droppedOverCap).toBe(1);
  });

  it('reports no truncation when well under the limit', () => {
    const items: Item[] = Array.from({ length: 2 }, (_, i) => ({ key: `n${i}`, ticketed: false }));
    const result = capNewRows(items, 50, isAlreadyTicketed);
    expect(result.included).toHaveLength(2);
    expect(result.totalNewMatched).toBe(2);
    expect(result.droppedOverCap).toBe(0);
  });

  it('always includes already-ticketed items without counting them toward the cap', () => {
    const items: Item[] = [
      { key: 'ticketed-1', ticketed: true },
      ...Array.from({ length: 3 }, (_, i) => ({ key: `n${i}`, ticketed: false })),
      { key: 'ticketed-2', ticketed: true },
    ];
    const result = capNewRows(items, 3, isAlreadyTicketed);
    expect(result.included.map(i => i.key)).toEqual(['ticketed-1', 'n0', 'n1', 'n2', 'ticketed-2']);
    expect(result.totalNewMatched).toBe(3);
    expect(result.droppedOverCap).toBe(0);
  });
});

describe('buildReviewRows', () => {
  interface Item { id: string; label: string }
  interface Row { id: string; existingTicketKey: string | null; included: boolean; label: string }

  it('assigns sequential numeric ids to new items and A-prefixed ids to already-ticketed ones, in source order', () => {
    const items: Item[] = [
      { id: 'x1', label: 'alpha' },
      { id: 'x2', label: 'beta' }, // already ticketed
      { id: 'x3', label: 'gamma' },
      { id: 'x4', label: 'delta' }, // already ticketed
    ];
    const dedupMap = new Map([['beta', 'PROJ-501'], ['delta', 'PROJ-502']]);

    const rows = buildReviewRows<Item, Row>(items, dedupMap, item => item.label, item => ({ label: item.label }));

    expect(rows.map(r => ({ id: r.id, existingTicketKey: r.existingTicketKey, included: r.included }))).toEqual([
      { id: '1', existingTicketKey: null, included: true },
      { id: 'A1', existingTicketKey: 'PROJ-501', included: false },
      { id: '2', existingTicketKey: null, included: true },
      { id: 'A2', existingTicketKey: 'PROJ-502', included: false },
    ]);
    expect(rows.map(r => r.label)).toEqual(['alpha', 'beta', 'gamma', 'delta']);
  });

  it('returns an empty array for empty input', () => {
    const rows = buildReviewRows<Item, Row>([], new Map(), item => item.label, item => ({ label: item.label }));
    expect(rows).toEqual([]);
  });
});
