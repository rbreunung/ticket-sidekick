// Shared, vscode-free pure utilities for the report-import flows (Veracode, Waltz OSS, and any
// future importer of the same shape: parse a report -> filter -> dedup-search against existing
// Jira tickets -> cap "new" candidates at a batch limit -> build review rows -> create tickets).
//
// R1: this is the single implementation for dedup search (chunking, JQL building, dedup-map
// extraction, fault-tolerant per-chunk search) and review-row building — importer-specific bits
// (what a "label" means, how a row's own fields are built) are injected via callbacks, not
// duplicated. R9: only what Veracode and Waltz need today is here — no speculative generality.
import type { DiagLogger } from './diagTypes';

// Single source of truth for both importers (KTD4). Both currently hardcode the identical values
// (20 MB / 50 tickets per run) independently; consuming these from here instead of the local
// copies is a later unit's job (extension.ts + both handler files).
export const MAX_REPORT_BYTES = 20 * 1024 * 1024; // 20 MB
export const BATCH_LIMIT = 50;

const DEFAULT_DEDUP_CHUNK_SIZE = 40; // keeps generated JQL well under Jira's practical query-length limits

/**
 * Splits `items` into chunks of at most `chunkSize`, preserving order. Generalized from the
 * byte-identical `chunkIssueIds`/`chunkComponentLabels` each importer had (they differed only in
 * parameter naming).
 */
export function chunkStrings(items: string[], chunkSize = DEFAULT_DEDUP_CHUNK_SIZE): string[][] {
  const chunks: string[][] = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    chunks.push(items.slice(i, i + chunkSize));
  }
  return chunks;
}

/**
 * Builds a dedup-search JQL clause for one chunk of labels. Always quotes labels (Waltz's
 * defensive form) — even a numeric-looking Veracode label like `veracode-issue-10101` is safe to
 * quote, and quoting uniformly means one implementation instead of a quoted/unquoted fork (KTD2).
 */
export function buildDedupJql(projectKey: string, labels: string[]): string {
  const quoted = labels.map(l => `"${l}"`).join(', ');
  return `project = ${projectKey} AND labels in (${quoted})`;
}

// Matches the raw Jira search-result shape (`fields.labels`, possibly absent) rather than a
// flattened `{ key, labels }[]` — KTD2.
export interface JqlIssueLike {
  key: string;
  fields: { labels?: string[] };
}

/**
 * Extracts a dedup-key -> ticket-key map from search results. `labelToDedupKey` is
 * importer-supplied: it inspects one label and either returns the dedup key it encodes (e.g. the
 * numeric Veracode issue id extracted from `veracode-issue-<id>`, or the Waltz component label
 * itself when it has the `oss-dep-` prefix) or `null` if the label is unrelated to this importer.
 */
export function extractDedupMap(
  issues: JqlIssueLike[],
  labelToDedupKey: (label: string) => string | null,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const issue of issues) {
    for (const label of issue.fields.labels ?? []) {
      const dedupKey = labelToDedupKey(label);
      if (dedupKey === null) continue;
      if (!map.has(dedupKey)) map.set(dedupKey, issue.key); // first match wins if somehow duplicated
    }
  }
  return map;
}

/**
 * Fault-tolerant, chunked dedup search (R5/AE2). `search` performs the actual Jira query for one
 * chunk of labels (built + executed by the caller, e.g. `chunk => ticketService.searchTicketsRaw(
 * buildDedupJql(projectKey, chunk), 100).then(r => r.issues)`) and is expected to already return
 * results in the `JqlIssueLike` shape. A chunk whose search rejects is logged via `onDiag` and
 * skipped — it must NOT discard the dedup matches already found by other, successful chunks, since
 * a caller-level catch-and-reset would silently re-treat already-ticketed items as new and create
 * duplicate tickets. Partial dedup coverage beats none.
 */
export async function findAlreadyTicketed(
  labels: string[],
  chunkSize: number,
  search: (chunk: string[]) => Promise<JqlIssueLike[]>,
  labelToDedupKey: (label: string) => string | null,
  onDiag?: DiagLogger,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const chunk of chunkStrings(labels, chunkSize)) {
    if (chunk.length === 0) continue;
    try {
      const issues = await search(chunk);
      const found = extractDedupMap(issues, labelToDedupKey);
      for (const [dedupKey, ticketKey] of found) map.set(dedupKey, ticketKey);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      onDiag?.('warn', 'Dedup search chunk failed — continuing with partial results', {
        chunkSize: chunk.length, error: message,
      });
    }
  }
  return map;
}

export interface CapNewRowsResult<TItem> {
  included: TItem[];
  totalNewMatched: number;
  droppedOverCap: number;
}

/**
 * Caps "new" (not-yet-ticketed) items at `batchLimit` *before* the (expensive) row-building step —
 * R7/AE4. Already-ticketed items (per `isAlreadyTicketed`) are always included, never capped.
 * `totalNewMatched` records the true count of new items the report matched, so the review screen
 * can state how many more exist beyond what's shown and that re-running the import picks them up
 * (the already-created tickets become dedup matches on the next run, for free).
 */
export function capNewRows<TItem>(
  items: TItem[],
  batchLimit: number,
  isAlreadyTicketed: (item: TItem) => boolean,
): CapNewRowsResult<TItem> {
  const included: TItem[] = [];
  let totalNewMatched = 0;
  let newSeen = 0;
  for (const item of items) {
    if (isAlreadyTicketed(item)) {
      included.push(item); // already-ticketed — always included, never capped
      continue;
    }
    totalNewMatched++;
    if (newSeen < batchLimit) {
      included.push(item);
      newSeen++;
    }
  }
  return { included, totalNewMatched, droppedOverCap: totalNewMatched - newSeen };
}

interface ReviewRowShape {
  id: string; // '1'..'N' new candidates, 'A1'..'Am' already-ticketed
  existingTicketKey: string | null;
  included: boolean; // whether this row will be (re)created if the batch runs
}

/**
 * Builds review rows from raw parsed items, assigning the shared id-numbering scheme (new
 * candidates numbered '1'..'N' in source order, already-ticketed ones 'A1'..'Am' in source order).
 * `dedupKeyOf` maps an item to the key looked up in `dedupMap`; `rowBuilder` supplies the
 * importer-specific row fields (everything beyond id/existingTicketKey/included).
 */
export function buildReviewRows<TItem, TRow extends ReviewRowShape>(
  items: TItem[],
  dedupMap: Map<string, string>,
  dedupKeyOf: (item: TItem) => string,
  rowBuilder: (item: TItem) => Omit<TRow, keyof ReviewRowShape>,
): TRow[] {
  const rows: TRow[] = [];
  let newIndex = 0;
  let ticketedIndex = 0;
  for (const item of items) {
    const existingTicketKey = dedupMap.get(dedupKeyOf(item)) ?? null;
    const base: ReviewRowShape = {
      id: existingTicketKey ? `A${++ticketedIndex}` : `${++newIndex}`,
      existingTicketKey,
      included: existingTicketKey === null,
    };
    rows.push({ ...base, ...rowBuilder(item) } as TRow);
  }
  return rows;
}
