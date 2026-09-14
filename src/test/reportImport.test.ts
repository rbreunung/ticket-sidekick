import { describe, it, expect, vi } from 'vitest';
import {
  chunkStrings, buildDedupJql, extractDedupMap, findAlreadyTicketed, capNewRows, buildReviewRows,
  sanitizeCellText, sanitizeStandaloneLine, resolveMaxReportBytes, findStaleTickets, buildStaleSearchJql,
  type JqlIssueLike,
} from '../utils/reportImport';

describe('resolveMaxReportBytes', () => {
  it('returns the default in bytes when given undefined', () => {
    expect(resolveMaxReportBytes(undefined, 50, 1, 200)).toBe(50 * 1024 * 1024);
  });

  it('returns the default in bytes when given a non-numeric value', () => {
    expect(resolveMaxReportBytes('50' as unknown, 50, 1, 200)).toBe(50 * 1024 * 1024);
  });

  it('returns the default in bytes when given a value below the minimum', () => {
    expect(resolveMaxReportBytes(0, 50, 1, 200)).toBe(50 * 1024 * 1024);
  });

  it('returns the default in bytes when given a value above the maximum', () => {
    expect(resolveMaxReportBytes(500, 50, 1, 200)).toBe(50 * 1024 * 1024);
  });

  it('returns the configured value in bytes when it is a valid in-range number', () => {
    expect(resolveMaxReportBytes(75, 50, 1, 200)).toBe(75 * 1024 * 1024);
  });
});

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

  it('strips Jira-native wiki-markup trigger characters (-+^?{}!)', () => {
    expect(sanitizeCellText('-struck- +underline+ ^super^ ??cite?? {quote}FAKE{quote} !http://evil.example/t.gif!'))
      .toBe('struck underline super cite quoteFAKEquote http://evil.example/t.gif');
  });

  it('neutralizes every trigger character in one crafted payload at once', () => {
    const crafted = 'Injected\n# Fake Heading\n| a | b |\n[click me](http://evil.example) *bold* ~~struck~~ '
      + '-struck- +underline+ ^super^ ??cite?? {quote}FAKE{quote} !http://evil.example/t.gif!';
    const sanitized = sanitizeCellText(crafted);
    expect(sanitized).not.toContain('\n');
    expect(sanitized).not.toContain('|');
    expect(sanitized).not.toMatch(/[*_`[\]~\-+^?{}!]/);
  });
});

describe('sanitizeStandaloneLine', () => {
  it('prefixes the sanitized value with ": " so it cannot occupy line-start position', () => {
    expect(sanitizeStandaloneLine('Critical')).toBe(': Critical');
  });

  it('prefixes before sanitizing, so a crafted ordered-list/heading/blockquote/horizontal-rule trigger no longer sits at line-start', () => {
    expect(sanitizeStandaloneLine('1. urgent')).toBe(': 1. urgent');
    // '-' is now stripped by sanitizeCellText itself (Jira-native strikethrough trigger), so the
    // horizontal-rule text disappears entirely rather than merely being pushed out of line-start.
    expect(sanitizeStandaloneLine('---')).toBe(': ');
    expect(sanitizeStandaloneLine('> quoted')).toBe(': > quoted');
    expect(sanitizeStandaloneLine('# fake heading')).toBe(': # fake heading');
  });

  it('still strips the same trigger characters sanitizeCellText does', () => {
    expect(sanitizeStandaloneLine('~~struck~~ *bold*')).toBe(': struck bold');
  });

  it('still strips Jira-native trigger characters, e.g. neutralizing a standalone remote-image-embed payload', () => {
    expect(sanitizeStandaloneLine('!http://evil.example/t.gif!')).toBe(': http://evil.example/t.gif');
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

    const result = await findAlreadyTicketed(labels, 40, search, (label) => label, onDiag);

    expect(result.map.get('label-40')).toBe('PROJ-9'); // second chunk's match survived
    expect(result.map.size).toBe(1); // first (failed) chunk contributed nothing, but didn't wipe the second's result
    expect(result.failedChunks).toBe(1);
    expect(result.totalChunks).toBe(2);
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

    const result = await findAlreadyTicketed(labels, 1, search, (label) => label);
    expect(result.map.get('a')).toBe('PROJ-a');
    expect(result.map.get('b')).toBe('PROJ-b');
    expect(result.map.get('c')).toBe('PROJ-c');
    expect(result.failedChunks).toBe(0);
    expect(result.totalChunks).toBe(3);
  });

  it('returns an empty map without calling search when given no labels', async () => {
    const search = vi.fn();
    const result = await findAlreadyTicketed([], 40, search, (label) => label);
    expect(result.map.size).toBe(0);
    expect(result.failedChunks).toBe(0);
    expect(result.totalChunks).toBe(0);
    expect(search).not.toHaveBeenCalled();
  });

  it('signals total coverage loss (failedChunks === totalChunks) distinctly from "zero matches with full coverage" (Finding #3)', async () => {
    const labels = Array.from({ length: 45 }, (_, i) => `label-${i}`); // 2 chunks of size 40/5
    const search = vi.fn<(chunk: string[]) => Promise<JqlIssueLike[]>>().mockRejectedValue(new Error('search unavailable'));
    const onDiag = vi.fn();

    const result = await findAlreadyTicketed(labels, 40, search, (label) => label, onDiag);

    expect(result.map.size).toBe(0);
    expect(result.failedChunks).toBe(2);
    expect(result.totalChunks).toBe(2);
    // Distinct from the "every chunk succeeded, found nothing" case below — same empty map, but
    // failedChunks/totalChunks tell the caller coverage was lost entirely rather than genuinely zero.
    expect(result.failedChunks).toBe(result.totalChunks);
  });

  it('"all chunks succeed with zero matches" reports full coverage, unlike total failure', async () => {
    const labels = Array.from({ length: 45 }, (_, i) => `label-${i}`);
    const search = async (): Promise<JqlIssueLike[]> => [];

    const result = await findAlreadyTicketed(labels, 40, search, (label) => label);

    expect(result.map.size).toBe(0);
    expect(result.failedChunks).toBe(0);
    expect(result.totalChunks).toBe(2);
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

describe('buildStaleSearchJql', () => {
  it('builds the open-tickets-carrying-marker-label search JQL', () => {
    expect(buildStaleSearchJql('PROJ', 'veracode')).toBe(
      'project = PROJ AND resolution is EMPTY AND labels = "veracode"',
    );
  });
});

describe('findStaleTickets', () => {
  // Mirrors the Veracode label shape (`veracode-issue-<id>`) for these importer-agnostic tests.
  const labelToDedupKey = (label: string) => {
    const match = label.match(/^veracode-issue-(\d+)$/);
    return match ? match[1] : null;
  };

  it('flags a single-flaw ticket stale when its flaw id is absent from the current report', async () => {
    const search = vi.fn().mockResolvedValue({
      issues: [{ key: 'PROJ-1', fields: { labels: ['veracode', 'veracode-issue-101'] } }],
      total: 1,
      isLast: true,
    });
    const isActive = () => false; // id 101 not present at all

    const result = await findStaleTickets('PROJ', 'veracode', search, labelToDedupKey, isActive);

    expect(result.stale).toEqual([{ key: 'PROJ-1', ids: ['101'] }]);
    expect(result.searchFailed).toBe(false);
    expect(result.truncated).toBe(false);
    expect(search).toHaveBeenCalledWith(buildStaleSearchJql('PROJ', 'veracode'), expect.any(Number));
  });

  it('flags a single-flaw ticket stale when its flaw id is present but no longer matches the remediation-status filter', async () => {
    const search = vi.fn().mockResolvedValue({
      issues: [{ key: 'PROJ-2', fields: { labels: ['veracode', 'veracode-issue-202'] } }],
      total: 1,
      isLast: true,
    });
    // id 202 exists in the report but its status has moved outside includeRemediationStatuses
    const isActive = (id: string) => id !== '202';

    const result = await findStaleTickets('PROJ', 'veracode', search, labelToDedupKey, isActive);

    expect(result.stale).toEqual([{ key: 'PROJ-2', ids: ['202'] }]);
  });

  it('does not flag a folded (multi-id) ticket stale when at least one of its ids is still active', async () => {
    const search = vi.fn().mockResolvedValue({
      issues: [{
        key: 'PROJ-3',
        fields: { labels: ['veracode', 'veracode-issue-301', 'veracode-issue-302', 'veracode-issue-303'] },
      }],
      total: 1,
      isLast: true,
    });
    // 302 is still active; 301/303 are gone — the ANY-active-keeps-non-stale rule (mirrors R11)
    const isActive = (id: string) => id === '302';

    const result = await findStaleTickets('PROJ', 'veracode', search, labelToDedupKey, isActive);

    expect(result.stale).toEqual([]);
  });

  it('flags a folded ticket stale only once every one of its ids is gone', async () => {
    const search = vi.fn().mockResolvedValue({
      issues: [{
        key: 'PROJ-4',
        fields: { labels: ['veracode', 'veracode-issue-401', 'veracode-issue-402'] },
      }],
      total: 1,
      isLast: true,
    });
    const isActive = () => false;

    const result = await findStaleTickets('PROJ', 'veracode', search, labelToDedupKey, isActive);

    expect(result.stale).toEqual([{ key: 'PROJ-4', ids: ['401', '402'] }]);
  });

  it('leaves a matched ticket alone (not stale) when it carries no extractable marker-id label', async () => {
    const search = vi.fn().mockResolvedValue({
      issues: [{ key: 'PROJ-5', fields: { labels: ['veracode'] } }],
      total: 1,
      isLast: true,
    });
    const isActive = () => false;

    const result = await findStaleTickets('PROJ', 'veracode', search, labelToDedupKey, isActive);

    expect(result.stale).toEqual([]);
  });

  it('surfaces truncation (more than 50 matching open tickets) instead of silently checking only the first 50', async () => {
    const issues = Array.from({ length: 50 }, (_, i) => ({
      key: `PROJ-${i}`,
      fields: { labels: [`veracode-issue-${i}`] },
    }));
    const search = vi.fn().mockResolvedValue({ issues, total: 73, isLast: false });
    const isActive = () => false;

    const result = await findStaleTickets('PROJ', 'veracode', search, labelToDedupKey, isActive);

    expect(result.truncated).toBe(true);
    expect(result.totalFound).toBe(73);
    expect(result.stale).toHaveLength(50); // still processes the first 50 rather than dropping coverage
  });

  it('degrades gracefully with a warning instead of throwing when the search rejects (mirrors findAlreadyTicketed)', async () => {
    const search = vi.fn().mockRejectedValue(new Error('search unavailable'));
    const onDiag = vi.fn();
    const isActive = () => false;

    const result = await findStaleTickets('PROJ', 'veracode', search, labelToDedupKey, isActive, onDiag);

    expect(result.searchFailed).toBe(true);
    expect(result.stale).toEqual([]);
    expect(onDiag).toHaveBeenCalledWith(
      'warn',
      expect.stringContaining('could not check for stale tickets'),
      expect.objectContaining({ error: expect.stringContaining('search unavailable') }),
    );
  });

  it('mirrors the Waltz case: a component present but excluded by includeRemediationActions is flagged stale', async () => {
    const waltzLabelToDedupKey = (label: string) => (label.startsWith('oss-dep-') ? label : null);
    const search = vi.fn().mockResolvedValue({
      issues: [{ key: 'PROJ-9', fields: { labels: ['oss-dependency', 'oss-dep-example-lib-1-2-3-abc123'] } }],
      total: 1,
      isLast: true,
    });
    // Component still present in the report, but its remediationAction no longer matches the
    // configured includeRemediationActions set — active-finding predicate returns false.
    const isActive = () => false;

    const result = await findStaleTickets('PROJ', 'oss-dependency', search, waltzLabelToDedupKey, isActive);

    expect(result.stale).toEqual([{ key: 'PROJ-9', ids: ['oss-dep-example-lib-1-2-3-abc123'] }]);
  });
});
