// Shared, vscode-free pure utilities for the report-import flows (Veracode, Waltz OSS, and any
// future importer of the same shape: parse a report -> filter -> dedup-search against existing
// Jira tickets -> cap "new" candidates at a batch limit -> build review rows -> create tickets).
//
// R1: this is the single implementation for dedup search (chunking, JQL building, dedup-map
// extraction, fault-tolerant per-chunk search) and review-row building — importer-specific bits
// (what a "label" means, how a row's own fields are built) are injected via callbacks, not
// duplicated. R9: only what Veracode and Waltz need today is here — no speculative generality.
import type { DiagLogger } from './diagTypes';
import { TRIGGER_CHARS_PATTERN } from './markdownToJiraWiki';
// Type-only import: erased at compile time (no runtime `require`), so this does not create the
// circular *runtime* import that sessionState.ts's own value import of this file (BATCH_LIMIT,
// sanitizeCellText) would otherwise raise — only a value/side-effect import can cycle.
import type { ReviewRowBase, TicketedAction } from '../participant/sessionState';

// Single source of truth for both importers (KTD4). Both currently hardcode the identical values
// (20 MB / 50 tickets per run) independently; consuming these from here instead of the local
// copies is a later unit's job (extension.ts + both handler files).
export const MAX_REPORT_BYTES = 20 * 1024 * 1024; // 20 MB — default-parameter fallback for the
// pure size-check/parse functions below (veracodeReport.ts/waltzReport.ts/reportImportHandler.ts);
// each config-reading call site now resolves its own configured value via resolveMaxReportBytes()
// instead of reading this constant directly.
export const BATCH_LIMIT = 50;

// Exported so callers that need to pass the value explicitly (e.g. findAlreadyTicketed) use this
// single source of truth instead of an independently-declared local copy of "40".
export const DEFAULT_DEDUP_CHUNK_SIZE = 40; // keeps generated JQL well under Jira's practical query-length limits

/**
 * Turns a configured `ticketSidekick.<x>.maxReportSizeMB`/`maxBatchSizeMB` setting value into a
 * validated byte limit — the single source of truth every config-reading call site (extension.ts's
 * two command registrations, veracodeHandler.ts, waltzHandler.ts, emailHandler.ts) uses instead of
 * re-implementing the same range check four times. A non-finite value or one outside
 * `[minMB, maxMB]` falls back to `defaultMB` rather than disabling the cap or throwing — a user
 * typo in settings.json must never leave an import unbounded.
 */
export function resolveMaxReportBytes(configuredMB: unknown, defaultMB: number, minMB: number, maxMB: number): number {
  const mb = typeof configuredMB === 'number' && Number.isFinite(configuredMB) && configuredMB >= minMB && configuredMB <= maxMB
    ? configuredMB
    : defaultMB;
  return mb * 1024 * 1024;
}

/**
 * Default and allowed range of each size-limit setting, keyed by its name under `ticketSidekick.`.
 * They repeat package.json's `default`/`minimum`/`maximum` (what VS Code's Settings screen shows),
 * because package.json isn't importable at runtime; reportImport.test.ts fails if the two differ.
 */
export const REPORT_SIZE_LIMITS_MB = {
  'email.maxBatchSizeMB': { defaultMB: 150, minMB: 1, maxMB: 500 },
  'veracode.maxReportSizeMB': { defaultMB: 50, minMB: 1, maxMB: 200 },
  'waltz.maxReportSizeMB': { defaultMB: 50, minMB: 1, maxMB: 200 },
} as const;

export type ReportSizeSetting = keyof typeof REPORT_SIZE_LIMITS_MB;

/** resolveMaxReportBytes() for one of the size-limit settings, reading its value through `read`
 * (the caller's `vscode.workspace.getConfiguration('ticketSidekick').get`, kept out of here so this
 * module stays vscode-free). */
export function resolveSizeLimitSetting(setting: ReportSizeSetting, read: (key: string) => unknown): number {
  const { defaultMB, minMB, maxMB } = REPORT_SIZE_LIMITS_MB[setting];
  return resolveMaxReportBytes(read(setting), defaultMB, minMB, maxMB);
}

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
// flattened `{ key, labels }[]` — KTD2. U3/KTD1: the dedup search also requests `resolution`
// (null = unresolved) and `created`; `status` is always returned by the search. All optional, so a
// search that did not request them (e.g. the stale search) still fits.
export interface JqlIssueLike {
  key: string;
  fields: {
    labels?: string[];
    resolution?: unknown;
    created?: string | null;
    status?: { name?: string } | null;
  };
}

/** U3/KTD1: one ticket carrying an item's dedup key, as the dedup search found it. */
export interface DedupTicket {
  key: string;
  labels: string[];
  /** True when the ticket has a resolution set (the same test the stale search uses). */
  resolved: boolean;
  /** Jira's `created` timestamp, or null when the search did not return one. */
  created: string | null;
  /** The ticket's status name, or null when the search did not return one. */
  status: string | null;
}

/** Dedup key -> every ticket carrying it (U3/KTD1 — no longer "first match wins"). */
export type DedupMap = Map<string, DedupTicket[]>;

function toDedupTicket(issue: JqlIssueLike): DedupTicket {
  const { fields } = issue;
  return {
    key: issue.key,
    labels: fields.labels ?? [],
    resolved: fields.resolution !== undefined && fields.resolution !== null,
    created: typeof fields.created === 'string' ? fields.created : null,
    status: typeof fields.status?.name === 'string' ? fields.status.name : null,
  };
}

function addTicket(map: DedupMap, dedupKey: string, ticket: DedupTicket): void {
  const list = map.get(dedupKey);
  if (!list) map.set(dedupKey, [ticket]);
  else if (!list.some(t => t.key === ticket.key)) list.push(ticket);
}

/**
 * Extracts a dedup-key -> tickets map from search results. `labelToDedupKey` is importer-supplied:
 * it inspects one label and either returns the dedup key it encodes (e.g. the numeric Veracode
 * issue id extracted from `veracode-issue-<id>`, or the Waltz component label itself when it has the
 * `oss-dep-` prefix) or `null` if the label is unrelated to this importer. U3/KTD1: every ticket
 * carrying a key is kept (each listed once per key), so a caller can union their findings and pick
 * the newest open one as the target.
 */
export function extractDedupMap(
  issues: JqlIssueLike[],
  labelToDedupKey: (label: string) => string | null,
): DedupMap {
  const map: DedupMap = new Map();
  for (const issue of issues) {
    const ticket = toDedupTicket(issue);
    for (const label of ticket.labels) {
      const dedupKey = labelToDedupKey(label);
      if (dedupKey === null) continue;
      addTicket(map, dedupKey, ticket);
    }
  }
  return map;
}

export interface FindAlreadyTicketedResult {
  map: DedupMap;
  failedChunks: number;
  totalChunks: number;
}

/**
 * Fault-tolerant, chunked dedup search (R5/AE2). `search` performs the actual Jira query for one
 * chunk of labels (built + executed by the caller, e.g. `chunk => ticketService.searchTicketsRaw(
 * buildDedupJql(projectKey, chunk), 100, ['resolution', 'created']).then(r => r.issues)`) and is
 * expected to already return results in the `JqlIssueLike` shape. A chunk whose search rejects is
 * logged via `onDiag` and skipped — it must NOT discard the dedup matches already found by other,
 * successful chunks, since a caller-level catch-and-reset would silently re-treat already-ticketed
 * items as new and create duplicate tickets. Partial dedup coverage beats none. Tickets for the
 * same key found by several chunks are merged, each listed once.
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
  const map: DedupMap = new Map();
  const chunks = chunkStrings(labels, chunkSize).filter(chunk => chunk.length > 0);
  let failedChunks = 0;
  for (const chunk of chunks) {
    try {
      const issues = await search(chunk);
      const found = extractDedupMap(issues, labelToDedupKey);
      for (const [dedupKey, tickets] of found) {
        for (const ticket of tickets) addTicket(map, dedupKey, ticket);
      }
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

/** Upper bound on tickets read for one dedup chunk, so a runaway search can't loop forever. */
export const MAX_DEDUP_TICKETS_PER_CHUNK = 1000;

/**
 * Reads every page of a Jira search. The dedup search needs this: an item's known findings are the
 * union of all its tickets (follow-ups and re-creates add more tickets per dedup label), so a single
 * truncated page could pick the wrong target or show recorded findings as new. Stops when a page is
 * short or empty, the server reports the end (`isLast`) or its `total` is reached, or `maxItems`
 * tickets were read. A failed page rejects, so `findAlreadyTicketed` treats the whole chunk as
 * failed rather than trusting a partial one.
 */
export async function fetchAllPages<T>(
  fetchPage: (startAt: number) => Promise<{ issues: T[]; total?: number; isLast?: boolean }>,
  pageSize: number,
  maxItems = MAX_DEDUP_TICKETS_PER_CHUNK,
): Promise<T[]> {
  const all: T[] = [];
  while (all.length < maxItems) {
    const page = await fetchPage(all.length);
    all.push(...page.issues.slice(0, maxItems - all.length));
    const done = page.issues.length < pageSize || page.isLast === true
      || (page.total !== undefined && all.length >= page.total);
    if (done) break;
  }
  return all;
}

/** One open ticket found stale by {@link findStaleTickets}. `ids` are the marker-id dedup keys
 * (e.g. Veracode flaw ids, or Waltz's `oss-dep-...` component label) extracted from its labels —
 * every one of them turned out inactive, which is what made the ticket stale. */
export interface StaleTicketMatch {
  key: string;
  ids: string[];
}

export interface FindStaleTicketsResult {
  stale: StaleTicketMatch[];
  /** Server-reported total match count (falls back to the checked-page length when the search
   * result carries no `total`), so a caller can report "N found" even when truncated. */
  totalFound: number;
  /** True when more than `BATCH_LIMIT` open tickets matched — only the first `BATCH_LIMIT` were
   * checked, mirroring `handleRunCleanup`'s cap-at-50-with-warning shape (cleanupHandler.ts). */
  truncated: boolean;
  /** True when `search` rejected — `stale` is then always `[]` (not "genuinely zero stale
   * tickets") and the caller should tell the user staleness could not be checked, mirroring
   * `findAlreadyTicketed`'s failedChunks/totalChunks distinction for the single-query case here. */
  searchFailed: boolean;
}

/**
 * Builds the JQL for U5's reverse stale-ticket search: open tickets in `projectKey` carrying the
 * importer's marker label (`veracode` / `oss-dependency`).
 */
export function buildStaleSearchJql(projectKey: string, markerLabel: string): string {
  return `project = ${projectKey} AND resolution is EMPTY AND labels = "${markerLabel}"`;
}

/**
 * R1/R5: finds open tickets whose finding(s) are gone from the current report or excluded by the
 * importer's own remediation filter. Runs one search (marker-label + `resolution is EMPTY`,
 * capped at `BATCH_LIMIT` — R1's "found N, showing first 50" shape, mirroring
 * `handleRunCleanup`'s analogous query in cleanupHandler.ts) rather than the chunked multi-query
 * shape `findAlreadyTicketed` uses for dedup, since this search is a single label/project filter,
 * not a large OR-list of dedup keys.
 *
 * For each candidate ticket, `labelToDedupKey` extracts every marker-id label it carries (e.g.
 * `veracode-issue-<id>` -> `<id>`, or Waltz's `oss-dep-...` label passed through as-is) and
 * `isActive` decides whether each one still matches a current, non-excluded finding. A ticket is
 * stale only when NONE of its ids are active (R2/R5's "any active keeps it non-stale" rule,
 * mirroring R11's folded-group rule). A ticket that matched the search but carries no
 * marker-id label at all is left alone rather than vacuously flagged stale — there's nothing to
 * compare against, and flagging it risks closing a ticket that only happens to share the marker
 * label.
 *
 * Never rejects — like `findAlreadyTicketed`, a failed search degrades to an empty `stale` list
 * plus `searchFailed: true` (logged via `onDiag`) rather than throwing and aborting the rest of
 * the import.
 */
export async function findStaleTickets(
  projectKey: string,
  markerLabel: string,
  search: (jql: string, maxResults: number) => Promise<{ issues: JqlIssueLike[]; total?: number; isLast?: boolean }>,
  labelToDedupKey: (label: string) => string | null,
  isActive: (dedupKey: string) => boolean,
  onDiag?: DiagLogger,
): Promise<FindStaleTicketsResult> {
  const jql = buildStaleSearchJql(projectKey, markerLabel);
  let result: { issues: JqlIssueLike[]; total?: number; isLast?: boolean };
  try {
    result = await search(jql, BATCH_LIMIT);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    onDiag?.('warn', 'Stale-ticket search failed — could not check for stale tickets', { error: message });
    return { stale: [], totalFound: 0, truncated: false, searchFailed: true };
  }

  const candidates = result.issues.slice(0, BATCH_LIMIT);
  const truncated = (result.total ?? 0) > BATCH_LIMIT || result.isLast === false;

  const stale: StaleTicketMatch[] = [];
  for (const issue of candidates) {
    const ids = (issue.fields.labels ?? [])
      .map(labelToDedupKey)
      .filter((id): id is string => id !== null);
    if (ids.length === 0) continue; // nothing to compare — see doc comment above
    if (!ids.some(isActive)) stale.push({ key: issue.key, ids });
  }

  return { stale, totalFound: result.total ?? candidates.length, truncated, searchFailed: false };
}

// U4: the pre-build "new" cap (`capNewRows`) that used to run here before review rows were built at
// all was removed — the review screen now pages through every matched "new" candidate instead of
// silently dropping the remainder of a run (see `buildReviewPage`/`ReviewSession` in
// sessionState.ts). Lightweight row fields still build eagerly for every candidate; an importer
// whose full ticket description is expensive (Veracode's folded-group description) defers that
// part to ticket-creation time instead, which is what actually avoids the wasted-work concern
// `capNewRows` used to guard against.

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
//   - '-' is stripped unless it sits between two ASCII letters or digits — Jira-native strikethrough
//     is `-text-` (not `~~text~~`; that Markdown form is what inline() converts *into* `-text-`, but
//     a value that already contains bare hyphens reaches Jira as literal `-text-` without ever
//     passing through that conversion). A hyphen flanked by letters or digits on both sides
//     ("netty-codec", "CVE-2099-1", "package-lock.json") can be neither an opening nor a closing
//     delimiter — the same word-boundary rule markdownToJiraWiki()'s JIRA_TRIGGER_SHAPES applies —
//     so it is kept and the value stays readable. Underscore does not count as a word character
//     here: it is stripped below, and "_-_foo_-_" must not turn into a live "-foo-". A letter
//     outside ASCII does not count either (conservative: its hyphen is stripped)
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
// Every character of TRIGGER_CHARS except '-', which is handled by its own flank rule below.
const NON_HYPHEN_TRIGGER_CHARS_PATTERN = new RegExp(TRIGGER_CHARS_PATTERN.source.replace('\\-', ''), 'g');
// A hyphen with anything other than an ASCII letter or digit on either side.
const BOUNDARY_HYPHEN_PATTERN = /(?<![A-Za-z0-9])-|-(?![A-Za-z0-9])/g;

export function sanitizeCellText(value: string): string {
  return value
    .replace(/\r\n|\r|\n/g, ' ')
    .replace(/\|/g, '/')
    .replace(BOUNDARY_HYPHEN_PATTERN, '')
    .replace(NON_HYPHEN_TRIGGER_CHARS_PATTERN, '');
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

// --- Size budgets for folded tickets (finding folding plan, KTD8/KTD9) ---------------------------
//
// Jira's default limits are 255 characters for a summary and about 32,767 for a description or
// comment. They are assumed, not checked against a live instance (see docs/known-limitations.md);
// the description budget leaves margin below the default.
export const MAX_SUMMARY_CHARS = 255;
export const MAX_DESCRIPTION_CHARS = 30_000;

/**
 * Joins a title's `head` (a file or component name — the only part that may be trimmed) and its
 * `tail` (finding count, CWE labels, rating suffix — never trimmed) within `max` characters. A
 * trimmed head ends in `…` so the cut is visible.
 */
export function clampSummary(head: string, tail: string, max: number = MAX_SUMMARY_CHARS): string {
  if (head.length + tail.length <= max) return head + tail;
  const room = Math.max(0, max - tail.length - 1);
  const clamped = `${head.slice(0, room)}…${tail}`;
  return clamped.length <= max ? clamped : clamped.slice(0, max);
}

/**
 * Builds wiki text at successively smaller detail levels (0 = full) until it fits `max`, and returns
 * the first level that does — or the smallest level when none fits, so a caller always gets an
 * answer. `shortened` is true whenever level 0 did not fit; the builder decides what each level
 * drops and how it tells the reader (its last level should list every finding but little else).
 */
export function fitWiki(
  build: (level: number) => string,
  levels: number,
  max: number = MAX_DESCRIPTION_CHARS,
): { wiki: string; shortened: boolean; level: number } {
  let wiki = '';
  for (let level = 0; level < levels; level++) {
    wiki = build(level);
    if (wiki.length <= max || level === levels - 1) return { wiki, shortened: level > 0, level };
  }
  return { wiki, shortened: false, level: 0 };
}

/**
 * U3/KTD2: what changed on an already-ticketed item since its tickets were made. `baseline` means
 * the tickets record no findings at all (created before record labels existed); `findings` lists
 * the new finding ids (possibly none, when only the rating rose) and an optional rating rise.
 * `null` (at the call sites) means no change.
 */
export type RowChange =
  | { kind: 'baseline' }
  | { kind: 'findings'; newIds: string[]; ratingRise?: { from: string; to: string } };

/** U3/KTD2: the importer's change describer, given the union of labels across all of an item's tickets. */
export interface RowChangeTracking<TItem> {
  describe(item: TItem, knownLabels: string[]): RowChange | null;
}

/** A template's `labels` field as a string array, or [] when it has none. */
export function templateLabelsOf(additionalFields: Record<string, unknown>): string[] {
  return Array.isArray(additionalFields.labels) ? additionalFields.labels as string[] : [];
}

export const TICKETED_ACTION_ORDER: readonly TicketedAction[] = ['update', 'follow-up', 'rewrite', 're-create', 'leave'];

function createdTime(created: string | null): number {
  if (!created) return Number.NEGATIVE_INFINITY;
  // Jira returns `+0000`-style offsets; normalize to `+00:00` so parsing does not rely on engine leniency.
  const ms = Date.parse(created.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
}

function keyNumber(key: string): number {
  const match = key.match(/-(\d+)$/);
  return match ? Number(match[1]) : Number.NEGATIVE_INFINITY;
}

function newestFirst(a: DedupTicket, b: DedupTicket): number {
  return (createdTime(b.created) - createdTime(a.created)) || (keyNumber(b.key) - keyNumber(a.key));
}

/**
 * KTD1/R11: an item's target ticket — the unresolved ticket with the latest `created` (ties: the
 * highest key number), or the newest ticket overall when every ticket is resolved. `tickets` must
 * be non-empty.
 */
export function pickTargetTicket(tickets: DedupTicket[]): DedupTicket {
  const open = tickets.filter(t => !t.resolved);
  return [...(open.length > 0 ? open : tickets)].sort(newestFirst)[0];
}

/**
 * R6/R7: which actions a row offers and which one it proposes. `follow-up` needs new findings; `rewrite` is always offered;
 * `update` needs a change or a baseline; `re-create` and `leave` are always offered. Default: no
 * change → leave; baseline → update; change with any open ticket → update; change with every ticket
 * resolved → follow-up, except a rating rise with no new findings → update.
 */
export function deriveTicketedActions(
  change: RowChange | null,
  anyOpen: boolean,
): { allowedActions: TicketedAction[]; action: TicketedAction } {
  const hasNewFindings = change?.kind === 'findings' && change.newIds.length > 0;
  // `rewrite` (finding folding) is always offered: it rebuilds the target ticket from the report.
  const allowed = new Set<TicketedAction>(['re-create', 'rewrite', 'leave']);
  if (change) allowed.add('update');
  if (hasNewFindings) allowed.add('follow-up');
  let action: TicketedAction;
  if (!change) action = 'leave';
  else if (change.kind === 'baseline' || anyOpen || !hasNewFindings) action = 'update';
  else action = 'follow-up';
  return { allowedActions: TICKETED_ACTION_ORDER.filter(a => allowed.has(a)), action };
}

/** Every distinct ticket across an item's dedup keys, in key-number order. */
function collectTickets(dedupMap: DedupMap, keys: string[]): DedupTicket[] {
  const byKey = new Map<string, DedupTicket>();
  for (const key of keys) {
    for (const ticket of dedupMap.get(key) ?? []) {
      if (!byKey.has(ticket.key)) byKey.set(ticket.key, ticket);
    }
  }
  return [...byKey.values()].sort((a, b) => keyNumber(a.key) - keyNumber(b.key));
}

/**
 * Builds review rows from raw parsed items, assigning the shared id-numbering scheme (new
 * candidates numbered '1'..'N' in source order, already-ticketed ones 'A1'..'Am' in source order).
 * `dedupKeyOf` maps an item to *every* candidate key looked up in `dedupMap` (R11: a folded group
 * matches as already-ticketed as soon as any one of its member flaws' keys does — a single-key
 * importer just returns a one-element array); `rowBuilder` supplies the importer-specific row
 * fields (everything beyond id/existingTicketKey/included).
 *
 * `existingTicketKey` is the item's target ticket ({@link pickTargetTicket}) across every ticket of
 * every key. U3: with `changeTracking`, an already-ticketed row also carries `ticketKeys`, `target`,
 * `change` (from the describer, given the union of all its tickets' labels), `allowedActions` and
 * the default `action` ({@link deriveTicketedActions}). Without it (email), rows keep the older shape.
 */
export function buildReviewRows<TItem, TRow extends ReviewRowBase>(
  items: TItem[],
  dedupMap: DedupMap,
  dedupKeyOf: (item: TItem) => string[],
  rowBuilder: (item: TItem) => Omit<TRow, keyof ReviewRowBase>,
  changeTracking?: RowChangeTracking<TItem>,
): TRow[] {
  const rows: TRow[] = [];
  let newIndex = 0;
  let ticketedIndex = 0;
  for (const item of items) {
    const keys = dedupKeyOf(item);
    const tickets = collectTickets(dedupMap, keys);
    const target = tickets.length > 0 ? pickTargetTicket(tickets) : null;
    const existingTicketKey = target ? target.key : null;
    const base: ReviewRowBase = {
      id: existingTicketKey ? `A${++ticketedIndex}` : `${++newIndex}`,
      existingTicketKey,
      included: existingTicketKey === null,
    };
    if (target && changeTracking) {
      const knownLabels = [...new Set(tickets.flatMap(t => t.labels))];
      const change = changeTracking.describe(item, knownLabels);
      const { allowedActions, action } = deriveTicketedActions(change, tickets.some(t => !t.resolved));
      base.ticketKeys = tickets.map(t => t.key);
      base.target = { key: target.key, status: target.status, resolved: target.resolved };
      base.change = change;
      base.allowedActions = allowedActions;
      base.action = action;
    }
    rows.push({ ...base, ...rowBuilder(item) } as TRow);
  }
  return rows;
}
