import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  chunkStrings, buildDedupJql, extractDedupMap, findAlreadyTicketed, buildReviewRows,
  sanitizeCellText, sanitizeStandaloneLine, resolveMaxReportBytes, findStaleTickets, buildStaleSearchJql,
  REPORT_SIZE_LIMITS_MB, resolveSizeLimitSetting, pickTargetTicket,
  type JqlIssueLike, type DedupTicket, type DedupMap, type RowChange,
  fetchAllPages, clampSummary, fitWiki, MAX_SUMMARY_CHARS, MAX_DESCRIPTION_CHARS,
} from '../utils/reportImport';
import type { ReviewRowBase } from '../participant/sessionState';
import { TRIGGER_CHARS } from '../utils/markdownToJiraWiki';

describe('size-limit settings', () => {
  const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf-8'));
  const settings: Record<string, { default?: unknown; minimum?: unknown; maximum?: unknown }> = Object.assign(
    {},
    ...[].concat(pkg.contributes.configuration).map((group: { properties?: object }) => group.properties ?? {}),
  );

  it('use the same default and range as the Settings screen (package.json)', () => {
    for (const [setting, limits] of Object.entries(REPORT_SIZE_LIMITS_MB)) {
      const declared = settings[`ticketSidekick.${setting}`];
      expect(declared, `ticketSidekick.${setting} is not in package.json`).toBeDefined();
      expect({ defaultMB: declared.default, minMB: declared.minimum, maxMB: declared.maximum }, setting).toEqual(limits);
    }
  });

  it('cover every size-limit setting package.json declares', () => {
    const declared = Object.keys(settings)
      .filter((key) => /\.max\w*SizeMB$/.test(key))
      .map((key) => key.replace(/^ticketSidekick\./, ''))
      .sort();
    expect(declared).toEqual(Object.keys(REPORT_SIZE_LIMITS_MB).sort());
  });

  it('read the configured value, and fall back to the default when it is out of range', () => {
    expect(resolveSizeLimitSetting('veracode.maxReportSizeMB', () => 120)).toBe(120 * 1024 * 1024);
    expect(resolveSizeLimitSetting('veracode.maxReportSizeMB', () => 999)).toBe(50 * 1024 * 1024);
    expect(resolveSizeLimitSetting('email.maxBatchSizeMB', () => undefined)).toBe(150 * 1024 * 1024);
  });
});

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

describe('sanitizeCellText covers the converter\'s whole trigger set', () => {
  it('strips every TRIGGER_CHARS character between letters, except the in-word hyphen and plus', () => {
    for (const ch of TRIGGER_CHARS) {
      const out = sanitizeCellText(`a${ch}b`);
      expect(out, `trigger ${ch}`).toBe(ch === '-' || ch === '+' ? `a${ch}b` : 'ab');
    }
  });

  it('strips a hyphen or plus at any boundary', () => {
    for (const ch of ['-', '+']) {
      expect(sanitizeCellText(`${ch}a`)).toBe('a');
      expect(sanitizeCellText(`a${ch}`)).toBe('a');
      expect(sanitizeCellText(`a ${ch} b`)).toBe('a  b');
    }
  });
});

describe('sanitizeCellText keeps hyphens and plus signs inside words', () => {
  it.each([
    ['netty-codec:4.1.100', 'netty-codec:4.1.100'],
    ['CVE-2099-1', 'CVE-2099-1'],
    ['/app/services/svc-0/package-lock.json', '/app/services/svc-0/package-lock.json'],
    ['state-of-the-art', 'state-of-the-art'],
    ['1.0.0+build.5', '1.0.0+build.5'],
    ['guava 31.1-jre+hotfix', 'guava 31.1-jre+hotfix'],
  ])('leaves %s unchanged', (value, expected) => {
    expect(sanitizeCellText(value)).toBe(expected);
  });

  it('still strips a hyphen at the start or end of a word, where Jira reads it as a strikethrough delimiter', () => {
    expect(sanitizeCellText('-struck-')).toBe('struck');
    expect(sanitizeCellText('a -b- c')).toBe('a b c');
    expect(sanitizeCellText('open Monday - Friday')).toBe('open Monday  Friday');
  });

  it('keeps only the inner hyphen of a wrapped compound word', () => {
    expect(sanitizeCellText('-a-b-')).toBe('a-b');
    expect(sanitizeCellText('x -y-z- w')).toBe('x y-z w');
  });

  it('strips hyphens next to another hyphen or any other trigger character', () => {
    expect(sanitizeCellText('a--b')).toBe('ab');
    expect(sanitizeCellText('a---b')).toBe('ab');
    expect(sanitizeCellText('a-+b')).toBe('ab');
    expect(sanitizeCellText('a-*b')).toBe('ab');
  });

  it('cannot assemble a strikethrough by stripping underscores around a hyphen', () => {
    // Were "_" counted as a word character, "_-_foo_-_" would leave "-foo-" once the underscores go.
    expect(sanitizeCellText('_-_foo_-_')).toBe('foo');
    expect(sanitizeCellText('x_-_y')).toBe('xy');
  });

  it('treats a letter outside ASCII as not a word character, so a hyphen next to it is stripped (conservative)', () => {
    expect(sanitizeCellText('a-über')).toBe('aüber');
    expect(sanitizeCellText('über-lib')).toBe('über-lib'); // the hyphen sits between "r" and "l", both ASCII
  });

  it('strips a plus sign at the start or end of a word, where Jira reads it as an underline delimiter', () => {
    expect(sanitizeCellText('+underline+')).toBe('underline');
    expect(sanitizeCellText('a +b+ c')).toBe('a b c');
    expect(sanitizeCellText('c++')).toBe('c');
    expect(sanitizeCellText('a++b')).toBe('ab');
    expect(sanitizeCellText('1 + 2')).toBe('1  2');
  });

  it('keeps only the inner plus sign of a wrapped word, and strips plus and hyphen next to each other', () => {
    expect(sanitizeCellText('+a+b+')).toBe('a+b');
    expect(sanitizeCellText('a-+b')).toBe('ab');
    expect(sanitizeCellText('a+-b')).toBe('ab');
  });

  it('cannot assemble an underline by stripping underscores around a plus sign', () => {
    expect(sanitizeCellText('_+_foo_+_')).toBe('foo');
  });

  it('never leaves a hyphen or plus sign that has a non-alphanumeric neighbor, whatever the payload', () => {
    const crafted = 'a-b -c- --d-- e-_-f -*-g -- ~-~ x-y-z -x- (-a-) [-b-] {-c-} !-d-! ?-e-? ^-f-^ +-g-+ '
      + 'a+b +c+ ++d++ e+_+f +*+g ~+~ x+y+z +x+ (+a+) [+b+] {+c+} !+d+! ?+e+? ^+f+^ -+g+-';
    expect(sanitizeCellText(crafted)).not.toMatch(/(?<![A-Za-z0-9])[-+]|[-+](?![A-Za-z0-9])/);
  });

  it('still removes every other trigger character, wherever it sits', () => {
    for (const char of '*_`[]~^?{}!') {
      expect(sanitizeCellText(`a${char}b ${char}c${char} ${char}`), char).not.toContain(char);
    }
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

// U3/KTD1: helper building one dedup-search ticket entry in the new key -> ticket-list shape.
function ticket(key: string, labels: string[], opts: { resolved?: boolean; created?: string | null; status?: string | null } = {}): DedupTicket {
  return {
    key,
    labels,
    resolved: opts.resolved ?? false,
    created: opts.created ?? null,
    status: opts.status ?? (opts.resolved ? 'Done' : 'Open'),
  };
}

describe('extractDedupMap', () => {
  const labelToDedupKey = (label: string) => (label.startsWith('oss-dep-') ? label : null);

  it('maps a matched label to the ticket with its labels, resolution, creation date and status', () => {
    const issues: JqlIssueLike[] = [
      {
        key: 'PROJ-1',
        fields: {
          labels: ['oss-dependency', 'oss-dep-example-lib-1-2-3'],
          resolution: { name: 'Done' },
          created: '2026-01-15T10:00:00.000+0000',
          status: { name: 'Done' },
        },
      },
      { key: 'PROJ-2', fields: { labels: ['unrelated'] } },
    ];
    const map = extractDedupMap(issues, labelToDedupKey);
    expect(map.get('oss-dep-example-lib-1-2-3')).toEqual([{
      key: 'PROJ-1',
      labels: ['oss-dependency', 'oss-dep-example-lib-1-2-3'],
      resolved: true,
      created: '2026-01-15T10:00:00.000+0000',
      status: 'Done',
    }]);
    expect(map.size).toBe(1);
  });

  it('keeps every ticket carrying the same dedup key, and treats a null resolution as unresolved', () => {
    const issues: JqlIssueLike[] = [
      { key: 'PROJ-8', fields: { labels: ['oss-dep-jackson'], resolution: { name: 'Done' }, status: { name: 'Done' } } },
      { key: 'PROJ-30', fields: { labels: ['oss-dep-jackson'], resolution: null, status: { name: 'Open' } } },
    ];
    const tickets = extractDedupMap(issues, labelToDedupKey).get('oss-dep-jackson')!;
    expect(tickets.map(t => [t.key, t.resolved, t.status])).toEqual([['PROJ-8', true, 'Done'], ['PROJ-30', false, 'Open']]);
  });

  it('lists a ticket once per key even when it carries the key label twice', () => {
    const issues: JqlIssueLike[] = [{ key: 'PROJ-1', fields: { labels: ['oss-dep-x', 'oss-dep-x'] } }];
    expect(extractDedupMap(issues, labelToDedupKey).get('oss-dep-x')).toHaveLength(1);
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

    expect(result.map.get('label-40')?.map(t => t.key)).toEqual(['PROJ-9']); // second chunk's match survived
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
      chunk.map((label) => ({ key: `PROJ-${label}`, fields: { labels: [label] } }));

    const result = await findAlreadyTicketed(labels, 1, search, (label) => label);
    expect(result.map.get('a')?.map(t => t.key)).toEqual(['PROJ-a']);
    expect(result.map.get('b')?.map(t => t.key)).toEqual(['PROJ-b']);
    expect(result.map.get('c')?.map(t => t.key)).toEqual(['PROJ-c']);
    expect(result.failedChunks).toBe(0);
    expect(result.totalChunks).toBe(3);
  });

  it('collects every ticket for a key across chunks without listing the same ticket twice', async () => {
    // PROJ-1 carries both labels, so both chunks return it; PROJ-2 only matches the second chunk.
    const search = async (chunk: string[]): Promise<JqlIssueLike[]> => chunk[0] === 'k1'
      ? [{ key: 'PROJ-1', fields: { labels: ['k1', 'k2'] } }]
      : [{ key: 'PROJ-1', fields: { labels: ['k1', 'k2'] } }, { key: 'PROJ-2', fields: { labels: ['k2'] } }];

    const result = await findAlreadyTicketed(['k1', 'k2'], 1, search, (label) => label);

    expect(result.map.get('k1')?.map(t => t.key)).toEqual(['PROJ-1']);
    expect(result.map.get('k2')?.map(t => t.key)).toEqual(['PROJ-1', 'PROJ-2']);
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

describe('pickTargetTicket', () => {
  it('picks the unresolved ticket with the latest created date', () => {
    const target = pickTargetTicket([
      ticket('PROJ-40', [], { created: '2026-01-01T09:00:00.000+0000' }),
      ticket('PROJ-12', [], { created: '2026-03-01T09:00:00.000+0000' }),
      ticket('PROJ-50', [], { created: '2026-06-01T09:00:00.000+0000', resolved: true }),
    ]);
    expect(target.key).toBe('PROJ-12');
  });

  it('breaks a created-date tie by the highest key number, not string order', () => {
    const created = '2026-01-01T09:00:00.000+0000';
    expect(pickTargetTicket([ticket('PROJ-9', [], { created }), ticket('PROJ-10', [], { created })]).key).toBe('PROJ-10');
  });

  it('falls back to the newest ticket overall when every ticket is resolved', () => {
    const target = pickTargetTicket([
      ticket('PROJ-8', [], { created: '2026-01-01T09:00:00.000+0000', resolved: true }),
      ticket('PROJ-9', [], { created: '2026-02-01T09:00:00.000+0000', resolved: true }),
    ]);
    expect(target.key).toBe('PROJ-9');
  });
});

describe('buildReviewRows', () => {
  interface Item { id: string; label: string }
  interface Row extends ReviewRowBase { label: string }

  it('assigns sequential numeric ids to new items and A-prefixed ids to already-ticketed ones, in source order', () => {
    const items: Item[] = [
      { id: 'x1', label: 'alpha' },
      { id: 'x2', label: 'beta' }, // already ticketed
      { id: 'x3', label: 'gamma' },
      { id: 'x4', label: 'delta' }, // already ticketed
    ];
    const dedupMap: DedupMap = new Map([['beta', [ticket('PROJ-501', ['beta'])]], ['delta', [ticket('PROJ-502', ['delta'])]]]);

    const rows = buildReviewRows<Item, Row>(items, dedupMap, item => [item.label], item => ({ label: item.label }));

    expect(rows.map(r => ({ id: r.id, existingTicketKey: r.existingTicketKey, included: r.included }))).toEqual([
      { id: '1', existingTicketKey: null, included: true },
      { id: 'A1', existingTicketKey: 'PROJ-501', included: false },
      { id: '2', existingTicketKey: null, included: true },
      { id: 'A2', existingTicketKey: 'PROJ-502', included: false },
    ]);
    expect(rows.map(r => r.label)).toEqual(['alpha', 'beta', 'gamma', 'delta']);
  });

  it('narrows only items with no existing ticket, drops those narrowed away, and keeps the surviving new ids contiguous', () => {
    const items: Item[] = [
      { id: 'x1', label: 'alpha' }, // narrowed away
      { id: 'x2', label: 'beta' }, // already ticketed: never narrowed
      { id: 'x3', label: 'gamma' }, // narrowed to a different label
      { id: 'x4', label: 'delta' },
    ];
    const dedupMap: DedupMap = new Map([['beta', [ticket('PROJ-501', ['beta'])]]]);
    const seen: string[] = [];
    const narrowNew = (item: Item): Item | null => {
      seen.push(item.label);
      if (item.label === 'alpha') return null;
      return item.label === 'gamma' ? { ...item, label: 'gamma-narrowed' } : item;
    };

    const rows = buildReviewRows<Item, Row>(items, dedupMap, item => [item.label], item => ({ label: item.label }), undefined, narrowNew);

    expect(seen).toEqual(['alpha', 'gamma', 'delta']);
    expect(rows.map(r => ({ id: r.id, label: r.label }))).toEqual([
      { id: 'A1', label: 'beta' },
      { id: '1', label: 'gamma-narrowed' },
      { id: '2', label: 'delta' },
    ]);
  });

  it('returns an empty array for empty input', () => {
    const rows = buildReviewRows<Item, Row>([], new Map(), item => [item.label], item => ({ label: item.label }));
    expect(rows).toEqual([]);
  });

  it('keeps today\'s row shape when no change tracking is given (email and not-yet-wired importers)', () => {
    const dedupMap: DedupMap = new Map([['beta', [ticket('PROJ-8', ['beta'], { resolved: true }), ticket('PROJ-30', ['beta'])]]]);

    const rows = buildReviewRows<Item, Row>(
      [{ id: 'x1', label: 'alpha' }, { id: 'x2', label: 'beta' }], dedupMap, item => [item.label], item => ({ label: item.label }),
    );

    expect(rows).toEqual([
      { id: '1', existingTicketKey: null, included: true, label: 'alpha' },
      { id: 'A1', existingTicketKey: 'PROJ-30', included: false, label: 'beta' },
    ]);
  });

  // U2/R11: multi-key dedupKeyOf — a folded group's own multiple candidate keys (one per member
  // flaw), not just a single-item's one label.
  describe('multi-key dedupKeyOf (folded groups, R11)', () => {
    interface Group { id: string; keys: string[] }
    interface GroupRow extends ReviewRowBase { keys: string[] }

    it('treats a group as already-ticketed when only one of its member keys matches', () => {
      const groups: Group[] = [{ id: 'g1', keys: ['issue-1', 'issue-2', 'issue-3'] }];
      const dedupMap: DedupMap = new Map([['issue-2', [ticket('PROJ-900', ['issue-2'])]]]); // only the 2nd of 3 member keys matches

      const rows = buildReviewRows<Group, GroupRow>(groups, dedupMap, g => g.keys, g => ({ keys: g.keys }));

      // Without change tracking the row keeps the plain shape — what is new on it is the change
      // describer's job (U3/U4), not a flag set here.
      expect(rows).toEqual([{
        id: 'A1', existingTicketKey: 'PROJ-900', included: false, keys: ['issue-1', 'issue-2', 'issue-3'],
      }]);
    });

    it('treats a group as new when none of its member keys match', () => {
      const groups: Group[] = [{ id: 'g1', keys: ['issue-1', 'issue-2', 'issue-3'] }];
      const dedupMap: DedupMap = new Map([['issue-99', [ticket('PROJ-900', ['issue-99'])]]]); // matches nothing in this group

      const rows = buildReviewRows<Group, GroupRow>(groups, dedupMap, g => g.keys, g => ({ keys: g.keys }));

      expect(rows).toEqual([{ id: '1', existingTicketKey: null, included: true, keys: ['issue-1', 'issue-2', 'issue-3'] }]);
    });
  });

  // U3/R3/R6/R7/KTD1: per-row target, change and default action once change tracking is given.
  describe('with change tracking (U3)', () => {
    // A Waltz-like item: one dedup key, a list of finding ids, and a rating. The describer below
    // mirrors describeWaltzChange's rules with plain `f-<id>` / `r-<rating>` record labels.
    interface Comp { key: string; findings: string[]; rating: number }
    interface CompRow extends ReviewRowBase { key: string }
    const describe_ = (c: Comp, known: string[]): RowChange | null => {
      const findingLabels = known.filter(l => l.startsWith('f-'));
      const ratings = known.filter(l => l.startsWith('r-')).map(l => Number(l.slice(2)));
      if (findingLabels.length === 0 && ratings.length === 0) return { kind: 'baseline' };
      const newIds = c.findings.filter(f => !known.includes(`f-${f}`));
      const knownRating = Math.max(...ratings);
      const ratingRise = ratings.length > 0 && c.rating > knownRating ? { from: String(knownRating), to: String(c.rating) } : undefined;
      if (newIds.length === 0 && !ratingRise) return null;
      return ratingRise ? { kind: 'findings', newIds, ratingRise } : { kind: 'findings', newIds };
    };
    const tracking = { describe: describe_ };
    const build = (items: Comp[], dedupMap: DedupMap) =>
      buildReviewRows<Comp, CompRow>(items, dedupMap, c => [c.key], c => ({ key: c.key }), tracking);

    it('Covers AE1: open ticket + change → update, all resolved + new findings → follow-up, no change → leave', () => {
      const dedupMap: DedupMap = new Map([
        ['log4j', [ticket('PROJ-12', ['log4j', 'f-A', 'r-3'], { status: 'In Progress' })]],
        ['jackson', [ticket('PROJ-8', ['jackson', 'f-A', 'r-3'], { resolved: true })]],
        ['commons', [ticket('PROJ-15', ['commons', 'f-A', 'r-3'])]],
      ]);
      const rows = build([
        { key: 'log4j', findings: ['A', 'B', 'C'], rating: 3 },
        { key: 'jackson', findings: ['A', 'B'], rating: 3 },
        { key: 'commons', findings: ['A'], rating: 3 },
      ], dedupMap);

      expect(rows.map(r => r.action)).toEqual(['update', 'follow-up', 'leave']);
      expect(rows[0]).toMatchObject({
        id: 'A1', existingTicketKey: 'PROJ-12', ticketKeys: ['PROJ-12'],
        target: { key: 'PROJ-12', status: 'In Progress', resolved: false },
        change: { kind: 'findings', newIds: ['B', 'C'] },
        allowedActions: ['update', 'follow-up', 'rewrite', 're-create', 'leave'],
      });
      expect(rows[1].allowedActions).toEqual(['update', 'follow-up', 'rewrite', 're-create', 'leave']);
      expect(rows[2].change).toBeNull();
      expect(rows[2].allowedActions).toEqual(['rewrite', 're-create', 'leave']);
    });

    it('Covers AE2: known findings are the union of every ticket; the target is the newest open ticket', () => {
      const dedupMap: DedupMap = new Map([['jackson', [
        ticket('PROJ-8', ['jackson', 'f-A', 'r-3'], { resolved: true, status: 'Done', created: '2026-01-01T09:00:00.000+0000' }),
        ticket('PROJ-30', ['jackson', 'f-B', 'r-3'], { status: 'Open', created: '2026-05-01T09:00:00.000+0000' }),
      ]]]);

      const [row] = build([{ key: 'jackson', findings: ['A', 'B', 'C'], rating: 3 }], dedupMap);

      expect(row.change).toEqual({ kind: 'findings', newIds: ['C'] });
      expect(row.target).toEqual({ key: 'PROJ-30', status: 'Open', resolved: false });
      expect(row.existingTicketKey).toBe('PROJ-30');
      expect(row.ticketKeys).toEqual(['PROJ-8', 'PROJ-30']);
      expect(row.action).toBe('update');
    });

    it('targets the later-created of two open tickets, and the higher key number on a created tie', () => {
      const dedupMap: DedupMap = new Map([
        ['a', [
          ticket('PROJ-40', ['a', 'f-A'], { created: '2026-06-01T09:00:00.000+0000' }),
          ticket('PROJ-41', ['a', 'f-A'], { created: '2026-02-01T09:00:00.000+0000' }),
        ]],
        ['b', [
          ticket('PROJ-99', ['b', 'f-A'], { created: '2026-02-01T09:00:00.000+0000' }),
          ticket('PROJ-100', ['b', 'f-A'], { created: '2026-02-01T09:00:00.000+0000' }),
        ]],
      ]);

      const rows = build([{ key: 'a', findings: ['A'], rating: 0 }, { key: 'b', findings: ['A'], rating: 0 }], dedupMap);

      expect(rows.map(r => r.target?.key)).toEqual(['PROJ-40', 'PROJ-100']);
    });

    it('Covers AE3 (detection): a ticket with only the dedup label is a baseline, defaulting to update without follow-up', () => {
      const dedupMap: DedupMap = new Map([['old', [ticket('PROJ-5', ['old'])]]]);

      const [row] = build([{ key: 'old', findings: ['A', 'B'], rating: 3 }], dedupMap);

      expect(row.change).toEqual({ kind: 'baseline' });
      expect(row.action).toBe('update');
      expect(row.allowedActions).toEqual(['update', 'rewrite', 're-create', 'leave']);
    });

    it('gives a baseline row whose only ticket is resolved that ticket as its target', () => {
      const dedupMap: DedupMap = new Map([['old', [ticket('PROJ-5', ['old'], { resolved: true, status: 'Done' })]]]);

      const [row] = build([{ key: 'old', findings: ['A'], rating: 3 }], dedupMap);

      expect(row.target).toEqual({ key: 'PROJ-5', status: 'Done', resolved: true });
      expect(row.action).toBe('update');
    });

    it('defaults a rating-only rise on all-resolved tickets to update, offering re-create but not follow-up', () => {
      const dedupMap: DedupMap = new Map([['lib', [ticket('PROJ-8', ['lib', 'f-A', 'r-3'], { resolved: true })]]]);

      const [row] = build([{ key: 'lib', findings: ['A'], rating: 4 }], dedupMap);

      expect(row.change).toEqual({ kind: 'findings', newIds: [], ratingRise: { from: '3', to: '4' } });
      expect(row.action).toBe('update');
      expect(row.allowedActions).toEqual(['update', 'rewrite', 're-create', 'leave']);
    });

    it('unions the labels of two different tickets holding a folded group\'s flaws (R2)', () => {
      interface Group { ids: string[] }
      interface GroupRow extends ReviewRowBase { ids: string[] }
      const seen: string[][] = [];
      const dedupMap: DedupMap = new Map([
        ['1', [ticket('PROJ-1', ['veracode-issue-1'])]],
        ['2', [ticket('PROJ-2', ['veracode-issue-2'])]],
      ]);

      const [row] = buildReviewRows<Group, GroupRow>(
        [{ ids: ['1', '2', '3'] }], dedupMap, g => g.ids, g => ({ ids: g.ids }),
        {
          describe: (g, known) => {
            seen.push(known);
            const newIds = g.ids.filter(id => !known.includes(`veracode-issue-${id}`));
            return newIds.length ? { kind: 'findings', newIds } : null;
          },
        },
      );

      expect([...seen[0]].sort()).toEqual(['veracode-issue-1', 'veracode-issue-2']);
      expect(row.change).toEqual({ kind: 'findings', newIds: ['3'] });
      expect(row.ticketKeys).toEqual(['PROJ-1', 'PROJ-2']);
    });

    it('does not call the describer or add action fields for a new (un-ticketed) row', () => {
      const describeSpy = vi.fn(() => null);
      const rows = buildReviewRows<Comp, CompRow>(
        [{ key: 'fresh', findings: ['A'], rating: 1 }], new Map(), c => [c.key], c => ({ key: c.key }), { describe: describeSpy },
      );
      expect(describeSpy).not.toHaveBeenCalled();
      expect(rows).toEqual([{ id: '1', existingTicketKey: null, included: true, key: 'fresh' }]);
    });
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

describe('fetchAllPages (dedup search paging)', () => {
  it('keeps fetching pages until the search is exhausted, so no matching ticket is dropped', async () => {
    const all = Array.from({ length: 250 }, (_, i) => ({ key: `PROJ-${i + 1}` }));
    const fetchPage = vi.fn(async (startAt: number) => ({ issues: all.slice(startAt, startAt + 100), total: 250 }));

    const issues = await fetchAllPages(fetchPage, 100);

    expect(issues).toHaveLength(250);
    expect(fetchPage.mock.calls.map(c => c[0])).toEqual([0, 100, 200]);
  });

  it('stops after one page when the result fits in it', async () => {
    const fetchPage = vi.fn(async () => ({ issues: [{ key: 'PROJ-1' }], total: 1 }));

    expect(await fetchAllPages(fetchPage, 100)).toHaveLength(1);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it('stops on a short page even when the server reports no total', async () => {
    const fetchPage = vi.fn(async (startAt: number) => ({ issues: startAt === 0 ? Array.from({ length: 100 }, (_, i) => ({ key: `P-${i}` })) : [{ key: 'P-100' }] }));

    expect(await fetchAllPages(fetchPage, 100)).toHaveLength(101);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it('never fetches beyond the safety cap', async () => {
    const fetchPage = vi.fn(async () => ({ issues: Array.from({ length: 100 }, (_, i) => ({ key: `P-${i}` })), total: 100000 }));

    const issues = await fetchAllPages(fetchPage, 100, 300);

    expect(issues).toHaveLength(300);
    expect(fetchPage).toHaveBeenCalledTimes(3);
  });

  it('passes a page failure through to the caller (findAlreadyTicketed then skips that chunk)', async () => {
    const fetchPage = vi.fn(async (startAt: number) => {
      if (startAt > 0) throw new Error('503');
      return { issues: Array.from({ length: 100 }, (_, i) => ({ key: `P-${i}` })), total: 150 };
    });

    await expect(fetchAllPages(fetchPage, 100)).rejects.toThrow('503');
  });
});

describe('clampSummary (R9: titles stay within Jira\'s summary limit)', () => {
  it('returns head + tail unchanged when it already fits', () => {
    expect(clampSummary('OrderRepository.java', ' - SQL Injection (7 findings)')).toBe('OrderRepository.java - SQL Injection (7 findings)');
  });

  it('trims only the head when too long, so the tail (count, labels, rating suffix) always survives', () => {
    const head = 'A'.repeat(300);
    const tail = ' - SQL Injection (7 findings)';
    const result = clampSummary(head, tail);
    expect(result.length).toBeLessThanOrEqual(MAX_SUMMARY_CHARS);
    expect(result.endsWith(tail)).toBe(true);
    expect(result.startsWith('AAAA')).toBe(true);
    expect(result).toContain('…');
  });

  it('honors an explicit smaller limit', () => {
    expect(clampSummary('abcdefghij', '!', 6).length).toBeLessThanOrEqual(6);
  });
});

describe('fitWiki (R10: descriptions and comments stay within the size budget)', () => {
  it('uses full detail (level 0) when it fits, and reports nothing shortened', () => {
    const result = fitWiki(level => `level ${level}`, 4, 100);
    expect(result).toEqual({ wiki: 'level 0', shortened: false, level: 0 });
  });

  it('steps down through the detail levels until the output fits', () => {
    const sizes = [500, 300, 90, 10];
    const result = fitWiki(level => 'x'.repeat(sizes[level]), 4, 100);
    expect(result.level).toBe(2);
    expect(result.shortened).toBe(true);
    expect(result.wiki).toHaveLength(90);
  });

  it('returns the smallest level when nothing fits, rather than failing', () => {
    const result = fitWiki(level => 'x'.repeat(1000 - level * 100), 3, 50);
    expect(result.level).toBe(2);
    expect(result.shortened).toBe(true);
  });

  it('defaults to the 30,000-character description budget', () => {
    expect(MAX_DESCRIPTION_CHARS).toBe(30_000);
    const result = fitWiki(level => (level === 0 ? 'x'.repeat(30_001) : 'ok'), 2);
    expect(result.level).toBe(1);
  });
});
