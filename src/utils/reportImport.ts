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

// Exported so callers that need to pass the value explicitly (e.g. findAlreadyTicketed) use this
// single source of truth instead of an independently-declared local copy of "40".
export const DEFAULT_DEDUP_CHUNK_SIZE = 40; // keeps generated JQL well under Jira's practical query-length limits

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

export interface FindAlreadyTicketedResult {
  map: Map<string, string>;
  failedChunks: number;
  totalChunks: number;
}

/**
 * Fault-tolerant, chunked dedup search (R5/AE2). `search` performs the actual Jira query for one
 * chunk of labels (built + executed by the caller, e.g. `chunk => ticketService.searchTicketsRaw(
 * buildDedupJql(projectKey, chunk), 100).then(r => r.issues)`) and is expected to already return
 * results in the `JqlIssueLike` shape. A chunk whose search rejects is logged via `onDiag` and
 * skipped — it must NOT discard the dedup matches already found by other, successful chunks, since
 * a caller-level catch-and-reset would silently re-treat already-ticketed items as new and create
 * duplicate tickets. Partial dedup coverage beats none.
 *
 * Never rejects — even when every chunk fails, this resolves with an empty `map` rather than
 * throwing. That leaves "zero matches" and "total search failure" looking identical to a caller
 * that only inspects `map`, so the result also carries `failedChunks`/`totalChunks`: when
 * `failedChunks === totalChunks && totalChunks > 0`, coverage was lost entirely and the caller
 * should tell the user dedup could not be checked, rather than silently proceeding as if the report
 * genuinely had zero already-ticketed items.
 */
export async function findAlreadyTicketed(
  labels: string[],
  chunkSize: number,
  search: (chunk: string[]) => Promise<JqlIssueLike[]>,
  labelToDedupKey: (label: string) => string | null,
  onDiag?: DiagLogger,
): Promise<FindAlreadyTicketedResult> {
  const map = new Map<string, string>();
  const chunks = chunkStrings(labels, chunkSize).filter(chunk => chunk.length > 0);
  let failedChunks = 0;
  for (const chunk of chunks) {
    try {
      const issues = await search(chunk);
      const found = extractDedupMap(issues, labelToDedupKey);
      for (const [dedupKey, ticketKey] of found) map.set(dedupKey, ticketKey);
    } catch (err) {
      failedChunks++;
      const message = err instanceof Error ? err.message : String(err);
      onDiag?.('warn', 'Dedup search chunk failed — continuing with partial results', {
        chunkSize: chunk.length, error: message,
      });
    }
  }
  return { map, failedChunks, totalChunks: chunks.length };
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

// Every value threaded through this function originates in externally-sourced report data (Waltz
// .xlsx cells, and — from a later unit onward — Veracode XML attributes) that gets interpolated
// into a hand-authored Markdown string ultimately converted via markdownToJiraWiki(). That
// converter is a simple line-based/regex converter with no escape-character support at all (a
// backslash has no special meaning to it), so neutralizing means removing or replacing the
// characters it treats as structural, not backslash-prefixing them:
//   - embedded newlines are flattened to a space FIRST — the converter re-parses every joined line
//     independently, so an embedded "\n# Fake Heading" or a full "\n| injected | row |" line would
//     otherwise inject a brand-new heading/table/list/quote/code-fence the author never wrote
//   - a literal '|' is replaced — inside one of our own table rows it would silently split into
//     extra cells and misalign the table (the line-based parser just does `line.split('|')`)
//   - '*', '_', '`', '[', ']' are stripped — inline() applies bold/italic/code-span/link formatting
//     anywhere in a line (not just at line-start), so a crafted CVE summary can't render a fake
//     clickable link, or bold/italic text the author never wrote
//   - '~' is stripped — inline()'s strikethrough regex (/~~(.+?)~~/g) is a mid-line transform just
//     like bold/italic; without stripping it, a "~~injected~~" value renders struck-through
//
// The characters above defeat markdownToJiraWiki()'s OWN recognizer. But the string this function
// protects doesn't stop being dangerous once it survives that converter — the *output* is sent to
// Jira verbatim as wiki markup, and Jira's renderer recognizes its own trigger set that
// markdownToJiraWiki() never touches and therefore never neutralizes on the way through:
//   - '-' is stripped — Jira-native strikethrough is `-text-` (not `~~text~~`; that Markdown form
//     is what inline() converts *into* `-text-`, but a value that already contains bare hyphens
//     reaches Jira as literal `-text-` without ever passing through that conversion)
//   - '+' is stripped — Jira-native underline is `+text+`
//   - '^' is stripped — Jira-native superscript is `^text^`
//   - '?' is stripped — Jira-native citation is `??text??`
//   - '{' and '}' are stripped — Jira macros are `{quote}`, `{color}`, `{panel}`, `{code}`,
//     `{noformat}`, etc.; without stripping, a crafted value can open one of these blocks early or
//     inject a fake one
//   - '!' is stripped — Jira-native remote image embed is `!url!`, the most concrete exploit: an
//     attacker-controlled field containing `!https://attacker.example/t.gif!` becomes an
//     auto-loading tracking pixel in the created ticket. (This is also defense-in-depth against
//     Markdown's own `![alt](url)` image syntax — but '[' and ']' being already stripped above
//     already prevents inline()'s `/!\[([^\]]*)\]\(([^)]+)\)/g` regex from matching, so stripping
//     '!' is redundant-but-harmless for that path and purely defensive against the Jira-native
//     `!url!` trigger, which needs no brackets at all.)
export function sanitizeCellText(value: string): string {
  return value
    .replace(/\r\n|\r|\n/g, ' ')
    .replace(/\|/g, '/')
    .replace(/[*_`[\]~\-+^?{}!]/g, '');
}

// A value pushed as an entire standalone line (no trusted prefix character in front of it, e.g.
// Waltz's maxVulnRating/nameVersion lines) is exposed to every line-start-anchored rule
// markdownToJiraWiki() has: the horizontal-rule check (repeated '-'/'*'/'_'), the blockquote check
// ('> '), the unordered-list check ('-'/'*'/'+ '), and the ordered-list check (digit(s) + '. ').
// sanitizeCellText() now strips '-' and '+' (as Jira-native strikethrough/underline triggers), but
// '>' and digits/'.' are still left untouched (stripping them would make CVE ids, version numbers,
// and legitimate prose unreadable) — so the blockquote and ordered-list checks are still reachable
// from line-start. Instead, prefixing the sanitized value with a literal ': ' pushes every
// character of the original value out of line-start position entirely: ':' is not a trigger
// character for any of those rules, and — unlike a whitespace prefix — it survives
// markdownToJiraWiki()'s leading-whitespace-consuming checks (the horizontal-rule test trims the
// line first via `.trim()`; the list regexes have a `(\s*)` capture group in front of their trigger
// character), so a whitespace-only prefix would not have closed this gap.
export function sanitizeStandaloneLine(value: string): string {
  return `: ${sanitizeCellText(value)}`;
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
