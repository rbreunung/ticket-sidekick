import { describe, it, expect } from 'vitest';
import {
  TokenUsageService,
  USAGE_STORAGE_KEY,
  formatTokenFooter,
  formatUsageTable,
  monthKey,
  normalizeStore,
  type UsageStorage,
} from '../utils/tokenUsage';

function fakeStorage(initial?: unknown, delayMs = 0): UsageStorage & { saved: () => unknown } {
  let value: unknown = initial;
  return {
    get: () => value,
    update: async (_key, next) => {
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      value = next;
    },
    saved: () => value,
  };
}

const exact = (input: number, output: number) => ({ input, output, estimated: false });

describe('monthKey', () => {
  it('formats the local month as YYYY-MM', () => {
    expect(monthKey(new Date(2026, 9, 1))).toBe('2026-10');
    expect(monthKey(new Date(2027, 0, 1))).toBe('2027-01');
  });
});

describe('TokenUsageService.record', () => {
  const october = () => new Date(2026, 9, 15);

  it('sums input, output and calls for the same month and model', async () => {
    const storage = fakeStorage();
    const service = new TokenUsageService(storage, october);
    await service.record('claude-sonnet', exact(100, 20));
    await service.record('claude-sonnet', exact(50, 10));
    expect(service.snapshot()['2026-10']['claude-sonnet']).toEqual({ input: 150, output: 30, calls: 2, estimated: false });
  });

  it('keeps separate rows per model', async () => {
    const service = new TokenUsageService(fakeStorage(), october);
    await service.record('claude-sonnet', exact(100, 20));
    await service.record('gpt-4.1', exact(7, 3));
    expect(Object.keys(service.snapshot()['2026-10']).sort()).toEqual(['claude-sonnet', 'gpt-4.1']);
  });

  it('keeps a row estimated once any call in it was estimated', async () => {
    const service = new TokenUsageService(fakeStorage(), october);
    await service.record('m', { input: 10, output: 5, estimated: true });
    await service.record('m', exact(10, 5));
    expect(service.snapshot()['2026-10']['m'].estimated).toBe(true);
  });

  it('deletes months older than the current month and the two before it when writing', async () => {
    const storage = fakeStorage({
      '2026-07': { m: { input: 1, output: 1, calls: 1, estimated: false } },
      '2026-08': { m: { input: 2, output: 2, calls: 1, estimated: false } },
      '2026-09': { m: { input: 3, output: 3, calls: 1, estimated: false } },
      '2026-10': { m: { input: 4, output: 4, calls: 1, estimated: false } },
    });
    const service = new TokenUsageService(storage, october);
    await service.record('m', exact(1, 1));
    expect(Object.keys(storage.saved() as object).sort()).toEqual(['2026-08', '2026-09', '2026-10']);
  });

  it('keeps November and December when the current month is January', async () => {
    const storage = fakeStorage({
      '2026-10': { m: { input: 1, output: 1, calls: 1, estimated: false } },
      '2026-11': { m: { input: 1, output: 1, calls: 1, estimated: false } },
      '2026-12': { m: { input: 1, output: 1, calls: 1, estimated: false } },
    });
    const service = new TokenUsageService(storage, () => new Date(2027, 0, 5));
    await service.record('m', exact(1, 1));
    expect(Object.keys(storage.saved() as object).sort()).toEqual(['2026-11', '2026-12', '2027-01']);
  });

  it('hides months outside the window when listing, without a write', () => {
    const storage = fakeStorage({
      '2026-06': { m: { input: 1, output: 1, calls: 1, estimated: false } },
      '2026-10': { m: { input: 4, output: 4, calls: 1, estimated: false } },
    });
    const service = new TokenUsageService(storage, october);
    expect(Object.keys(service.snapshot())).toEqual(['2026-10']);
    expect(Object.keys(storage.saved() as object)).toContain('2026-06');
  });

  it('keeps every call when several are started without awaiting the previous one', async () => {
    const storage = fakeStorage(undefined, 5);
    const service = new TokenUsageService(storage, october);
    await Promise.all([
      service.record('m', exact(1, 1)),
      service.record('m', exact(1, 1)),
      service.record('m', exact(1, 1)),
    ]);
    expect(service.snapshot()['2026-10']['m'].calls).toBe(3);
  });

  it('treats malformed stored data as empty and recovers on the next write', async () => {
    const storage = fakeStorage('not an object');
    const service = new TokenUsageService(storage, october);
    expect(service.snapshot()).toEqual({});
    await service.record('m', exact(2, 1));
    expect(service.snapshot()['2026-10']['m'].calls).toBe(1);
  });

  it('uses the documented storage key', async () => {
    const keys: string[] = [];
    const storage: UsageStorage = { get: (k) => { keys.push(k); return undefined; }, update: async (k) => { keys.push(k); } };
    await new TokenUsageService(storage, october).record('m', exact(1, 1));
    expect(new Set(keys)).toEqual(new Set([USAGE_STORAGE_KEY]));
  });
});

describe('normalizeStore', () => {
  it('drops rows with negative or non-finite numbers and keeps valid ones', () => {
    const store = normalizeStore({
      '2026-10': {
        good: { input: 5, output: 2, calls: 1, estimated: false },
        negative: { input: -1, output: 2, calls: 1, estimated: false },
        infinite: { input: Infinity, output: 2, calls: 1, estimated: false },
      },
      '2026-09': null,
    });
    expect(store).toEqual({ '2026-10': { good: { input: 5, output: 2, calls: 1, estimated: false } } });
  });
});

describe('formatUsageTable', () => {
  const now = new Date(2026, 9, 15);

  it('shows one row per month and model, newest month first', () => {
    const table = formatUsageTable({
      '2026-09': { 'claude-sonnet': { input: 2_050_000, output: 301_000, calls: 44, estimated: false } },
      '2026-10': {
        'gpt-4.1': { input: 310_000, output: 42_000, calls: 8, estimated: false },
        'claude-sonnet': { input: 1_240_000, output: 188_000, calls: 27, estimated: false },
      },
    }, now);
    const rows = table.split('\n').filter((l) => l.startsWith('| 2026'));
    expect(rows).toEqual([
      '| 2026-10 | claude-sonnet | 1,240,000 | 188,000 | 27 |',
      '| 2026-10 | gpt-4.1 | 310,000 | 42,000 | 8 |',
      '| 2026-09 | claude-sonnet | 2,050,000 | 301,000 | 44 |',
    ]);
  });

  it('marks rows with estimated figures', () => {
    const table = formatUsageTable({ '2026-10': { m: { input: 10, output: 5, calls: 1, estimated: true } } }, now);
    expect(table).toContain('| 2026-10 | m | ~10 | ~5 | 1 |');
  });

  it('says so instead of showing an empty table', () => {
    expect(formatUsageTable({}, now)).toBe('_No token usage recorded yet._');
    expect(formatUsageTable({ '2026-01': { m: { input: 1, output: 1, calls: 1, estimated: false } } }, now)).toBe('_No token usage recorded yet._');
  });

  it('escapes pipes in model ids so the table keeps its shape', () => {
    const table = formatUsageTable({ '2026-10': { 'a|b': { input: 1, output: 1, calls: 1, estimated: false } } }, now);
    expect(table).toContain('| 2026-10 | a\\|b | 1 | 1 | 1 |');
  });
});

describe('formatTokenFooter', () => {
  it('writes input, output, model and budget on one line', () => {
    expect(formatTokenFooter({ input: 41_230, output: 6_840, estimated: false, modelId: 'claude-sonnet-4.5', budget: 90_000 }))
      .toBe('_Tokens: 41,230 in · 6,840 out · claude-sonnet-4.5 · budget 90,000_');
  });

  it('omits the budget segment when none applies', () => {
    expect(formatTokenFooter({ input: 1_200, output: 300, estimated: false, modelId: 'm' }))
      .toBe('_Tokens: 1,200 in · 300 out · m_');
  });

  it('escapes markdown characters in the model id so the italic line stays intact', () => {
    expect(formatTokenFooter({ input: 1, output: 1, estimated: false, modelId: 'gpt_4o*mini' }))
      .toBe('_Tokens: 1 in · 1 out · gpt\\_4o\\*mini_');
  });

  it('marks estimated figures with a tilde', () => {
    expect(formatTokenFooter({ input: 1_200, output: 300, estimated: true, modelId: 'm' }))
      .toBe('_Tokens: ~1,200 in · ~300 out · m_');
  });
});
