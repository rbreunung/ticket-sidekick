/**
 * Monthly per-model token counters for `@bitbucket`, plus the footer line and usage table built
 * from them. Pure and `vscode`-free so Vitest can load it: persistence goes through the small
 * `UsageStorage` interface (VS Code's `Memento` satisfies it).
 */

export interface TokenFigures {
  input: number;
  output: number;
  /** True when any figure came from the `chars / 4` fallback instead of the model's own counter. */
  estimated: boolean;
}

export interface UsageRow {
  input: number;
  output: number;
  calls: number;
  estimated: boolean;
}

/** `{ 'YYYY-MM': { [modelId]: row } }` */
export type UsageStore = Record<string, Record<string, UsageRow>>;

export interface UsageStorage {
  get(key: string): unknown;
  update(key: string, value: unknown): PromiseLike<void> | void;
}

export const USAGE_STORAGE_KEY = 'bitbucket.tokenUsage';

/** Months kept: the current one plus the two before it. */
const RETAINED_MONTHS = 3;

const NO_USAGE_MESSAGE = '_No token usage recorded yet._';

export function monthKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

/** Current month first, then the two before it. */
export function retainedMonths(now: Date): string[] {
  const months: string[] = [];
  for (let back = 0; back < RETAINED_MONTHS; back++) {
    months.push(monthKey(new Date(now.getFullYear(), now.getMonth() - back, 1)));
  }
  return months;
}

const isCount = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;

/** Keeps only well-formed rows; anything else in stored data is treated as absent. */
export function normalizeStore(raw: unknown): UsageStore {
  const store: UsageStore = {};
  if (!raw || typeof raw !== 'object') return store;
  for (const [month, models] of Object.entries(raw as Record<string, unknown>)) {
    if (!models || typeof models !== 'object') continue;
    const rows: Record<string, UsageRow> = {};
    for (const [modelId, row] of Object.entries(models as Record<string, unknown>)) {
      const r = row as Partial<UsageRow> | null;
      if (r && isCount(r.input) && isCount(r.output) && isCount(r.calls)) {
        rows[modelId] = { input: r.input, output: r.output, calls: r.calls, estimated: r.estimated === true };
      }
    }
    if (Object.keys(rows).length > 0) store[month] = rows;
  }
  return store;
}

function withinWindow(store: UsageStore, now: Date): UsageStore {
  const keep = new Set(retainedMonths(now));
  return Object.fromEntries(Object.entries(store).filter(([month]) => keep.has(month)));
}

export class TokenUsageService {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly storage: UsageStorage,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Adds one model call to the current month's counter and drops months outside the window. */
  record(modelId: string, figures: TokenFigures): Promise<void> {
    const run = this.queue.then(async () => {
      const now = this.now();
      const store = withinWindow(normalizeStore(this.storage.get(USAGE_STORAGE_KEY)), now);
      const month = monthKey(now);
      const row = store[month]?.[modelId];
      store[month] = {
        ...store[month],
        [modelId]: {
          input: (row?.input ?? 0) + figures.input,
          output: (row?.output ?? 0) + figures.output,
          calls: (row?.calls ?? 0) + 1,
          estimated: (row?.estimated ?? false) || figures.estimated,
        },
      };
      await this.storage.update(USAGE_STORAGE_KEY, store);
    });
    // A failed write must not poison later writes, but the caller still sees the failure.
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Stored usage inside the retention window. */
  snapshot(): UsageStore {
    return withinWindow(normalizeStore(this.storage.get(USAGE_STORAGE_KEY)), this.now());
  }
}

const fmt = (n: number): string => n.toLocaleString('en-US');

export function formatTokenFooter(params: {
  input: number;
  output: number;
  estimated: boolean;
  modelId: string;
  budget?: number;
}): string {
  const mark = params.estimated ? '~' : '';
  const parts = [
    `Tokens: ${mark}${fmt(params.input)} in`,
    `${mark}${fmt(params.output)} out`,
    params.modelId,
  ];
  if (params.budget !== undefined) parts.push(`budget ${fmt(params.budget)}`);
  return `_${parts.join(' · ')}_`;
}

export function formatUsageTable(store: UsageStore, now: Date): string {
  const visible = withinWindow(store, now);
  const months = Object.keys(visible).sort().reverse();
  const lines: string[] = [];
  for (const month of months) {
    for (const modelId of Object.keys(visible[month]).sort()) {
      const row = visible[month][modelId];
      const mark = row.estimated ? '~' : '';
      lines.push(`| ${month} | ${modelId.replace(/\|/g, '\\|')} | ${mark}${fmt(row.input)} | ${mark}${fmt(row.output)} | ${fmt(row.calls)} |`);
    }
  }
  if (lines.length === 0) return NO_USAGE_MESSAGE;
  return [
    '| Month | Model | Input | Output | Calls |',
    '| --- | --- | ---: | ---: | ---: |',
    ...lines,
    '',
    '_Counts are approximate (the editor\'s tokenizer, not provider billing). `~` marks estimated figures. The current month and the two before it are kept._',
  ].join('\n');
}
