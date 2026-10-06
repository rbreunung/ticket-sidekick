// History serialization, comment lists, search/filter/bulk-update sessions and their reply parsing, attachment selection, issue-type helpers, generic review-input parsing.
// Pure (vscode-free); re-exported through ../sessionState.ts.

import type { JiraComment, JiraFieldMeta, JiraFilter, JiraSprintCandidate } from '../../jira/IJiraClient';
import { formatJiraBody } from '../../utils/markdownFormatter';
import { ReviewTableColumn, TICKET_KEY_TOKEN, buildChatCommandLink, isCancellation, isConfirmation, neutralizeMarkdownLinks, renderReviewTable } from './primitives';
import { CommentListSession, PendingSearchConstraints } from './sessionTypes';

// Defensive sanitizer over LLM history text (llmHelpers.ts): no code path emits HTML-comment
// markers anymore since the R13 metadata migration, but history turns from pre-migration
// versions may still carry them — strip before that text is fed back into an LLM prompt.
export function stripHiddenMarkers(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, '').replace(/\s+/g, ' ').trim();
}

const MAX_HISTORY_CHARS = 30_000;

export function serializeTurns(
  turns: Array<{ role: 'user' | 'assistant'; text: string }>,
  mode: 'recent' | 'full',
): string {
  const selected = mode === 'recent' ? turns.slice(-10) : turns;
  const serialized = selected
    .filter((t) => t.text.length > 0)
    .map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.text}`)
    .join('\n\n');
  if (serialized.length <= MAX_HISTORY_CHARS) return serialized;
  const tail = serialized.slice(-MAX_HISTORY_CHARS);
  const turnBoundary = /\n\n(User|Assistant): /.exec(tail);
  const clean = turnBoundary ? tail.slice(turnBoundary.index + 2) : tail;
  return `_(oldest turns omitted to fit context)_\n\n${clean}`;
}

/** KTD3: unlike isCancellation()'s broad word list (which treats a literal "stop" as
 * cancellation), the template-generation flow's R2/R3 chat-asks (a template name, a free-text
 * issue type) recognize only an explicit "(c)" reply as cancellation, checked before any other
 * interpretation — so a template or issue type genuinely named "Stop" stays enterable there. This
 * is a deliberate, one-time divergence scoped to those two new asks; handleAwaitSummaryReply (an
 * existing, different session type in templateGenerationHandler.ts) keeps its own unmodified
 * isCancellation() check. */
export function isExplicitCancelToken(reply: string): boolean {
  return reply.trim().toLowerCase() === '(c)';
}

export type AwaitFreeTextReply =
  | { action: 'cancel' }
  | { action: 'empty' }
  | { action: 'value'; value: string };

/** Shared parser for the template-generation flow's two free-text chat-asks (R2's template name,
 * R3's free-text issue type) — both just need "a non-empty string, or cancel/re-prompt", so one
 * parser covers both; each caller assigns the returned value to whichever field it means
 * (templateName / issueType). Cancellation uses isExplicitCancelToken() (KTD3), not
 * isCancellation(). */
export function parseAwaitFreeTextReply(reply: string): AwaitFreeTextReply {
  if (isExplicitCancelToken(reply)) return { action: 'cancel' };
  const trimmed = reply.trim();
  if (trimmed.length === 0) return { action: 'empty' };
  return { action: 'value', value: trimmed };
}

export function buildCommentListSession(ticketKey: string, comments: JiraComment[]): CommentListSession {
  return {
    ticketKey,
    comments: comments.map((c, i) => ({
      index: i + 1,
      author: c.author.displayName,
      date: c.created.slice(0, 10),
      bodyMarkdown: formatJiraBody(c.body).trim() || '_empty_',
    })),
  };
}

export function formatCommentsInFull(comments: JiraComment[]): string {
  return comments.map((c, i) => {
    const date = c.created.slice(0, 10);
    const body = formatJiraBody(c.body).trim() || '_empty_';
    return `**${i + 1}. ${c.author.displayName}** (${date})\n\n${body}`;
  }).join('\n\n---\n\n');
}

export function parseCommentIndex(reply: string, maxIndex: number): number | 'invalid' {
  const match = reply.match(/\b(\d+)\b/);
  if (!match) return 'invalid';
  const n = parseInt(match[1], 10);
  if (n >= 1 && n <= maxIndex) return n;
  return 'invalid';
}

export interface FilterSelectionSession {
  filters: JiraFilter[];
  originalPrompt: string;
  // U4/R4: set only when the triggering message also named a fixVersion/sprint/assignee
  // constraint — resolved after the filter itself is picked (see resolveConstraintsAndSearch).
  pendingConstraints?: PendingSearchConstraints;
}

// Intentionally excluded from the `JiraSessionContinuity` metadata migration: this session is
// written to workspaceState in the background and silently overwritten by the next search — it
// never had a reply-detection tag/branch to convert, so there's nothing to migrate here.
export interface SearchResultSession {
  ticketKeys: string[];
  jql: string;
  // U5/R7-R8: per-ticket project/issue-type metadata, populated only by the plain `searchJql`
  // path (the only writer that needs it, since it's also the only one that computes refine-chip
  // eligibility) — used to decide whether every ticket in the result shares one project (R8's
  // sprint-refine-chip precondition). Optional: every other writer of this session (filter runs,
  // R5's bare-constraint narrowing) keeps compiling and behaving unchanged without populating it,
  // and `ticketKeys` stays the one field `bulkTransition` and the rest of this file's existing
  // readers rely on.
  tickets?: { key: string; projectKey: string | null; issueType: string }[];
}

export interface BulkUpdateReviewSession {
  // U6/KTD6: rows (not just keys) so a toggle round-trip needs no re-fetch — each row's own
  // `included` flag persists across turns, same convention as ReviewRowBase/TransitionBatchTicket.
  rows: BulkUpdateReviewRow[];
  fieldId: string;
  fieldName: string;
  fieldValue: unknown;
  arrayOp: 'set' | 'add' | 'remove';
  // Code-review fix: the initial render's own header (field name/value, ticket count, "View in
  // Jira" link) built once and reused verbatim by buildBulkUpdateReviewMessage() on every
  // toggle-resume render — previously the resume render duplicated a shorter, hand-written header
  // that had already drifted from the initial one (missing the count and the Jira link).
  headerLine: string;
}

/**
 * Assembles a bulk-update review response — `session`'s own stored header line, the table (current
 * `rows`, which may differ from `session.rows` right after a toggle), and the confirm/cancel/toggle
 * footer — shared by both the initial render and every toggle-resume render so they can't drift
 * apart (code-review fix).
 */
export function buildBulkUpdateReviewMessage(headerLine: string, rows: BulkUpdateReviewRow[]): string {
  return (
    `${headerLine}\n\n` +
    buildBulkUpdateReviewTable(rows) +
    `\n\nReply ${buildChatCommandLink('Post it', '@jira', 'post it')} to apply, ` +
    `${buildChatCommandLink('Cancel', '@jira', 'cancel')} to cancel, or list keys to toggle (e.g. \`skip PROJ-2\`).`
  );
}

export interface FieldUpdatePreviewSession {
  ticketKeys: string[];
  fieldId: string;
  fieldName: string;
  fieldValue: unknown;
  isArray: boolean;
  arrayOp: 'set' | 'add' | 'remove';
}

export interface FieldSelectionSession {
  candidates: JiraFieldMeta[];
  pending: {
    fieldValue: string;
    arrayOp: 'set' | 'add' | 'remove';
    ticketKeys: string[];
  };
}

export interface SprintSelectionSession {
  candidates: JiraSprintCandidate[];
  pending:
    | { kind: 'field-update'; session: FieldUpdatePreviewSession }
    | { kind: 'creation'; sprintFieldId: string };
}

// U6/KTD6: 'ok'/'skip' -> 'ok'/'toggle' — a key list (typed "skip PROJ-2 PROJ-5", or a bare list a
// row's own toggle click resubmits, e.g. "PROJ-2") now flips those rows' `included` and re-renders
// (R8/AE4), rather than the pre-U6 one-shot "these are excluded, run the rest now." Only 'ok'
// (e.g. "post it") actually runs the update, using each row's current `included` flag.
export type BulkUpdateReviewParseResult =
  | { action: 'ok' }
  | { action: 'cancel' }
  | { action: 'toggle'; keys: string[] }
  | { action: 'invalid' };

export function parseBulkUpdateReview(reply: string): BulkUpdateReviewParseResult {
  const trimmed = reply.trim();
  if (!trimmed) return { action: 'invalid' };
  if (isCancellation(reply)) return { action: 'cancel' };
  if (isConfirmation(reply)) return { action: 'ok' };
  const skipMatch = trimmed.match(/^skip\s+(.*)/i);
  // A bare key list (no "skip" prefix) is what a row's own toggle link resubmits (R8/KTD6) — accept
  // it the same way, without requiring the typed "skip" keyword.
  const tokenSource = skipMatch ? skipMatch[1] : trimmed;
  const keys = tokenSource.trim().split(/[\s,]+/).filter(Boolean)
    .filter(t => TICKET_KEY_TOKEN.test(t))
    .map(t => t.toUpperCase());
  if (keys.length === 0) return { action: 'invalid' };
  return { action: 'toggle', keys };
}

export function parseFilterSelection(reply: string, filters: JiraFilter[]): JiraFilter | 'cancel' | 'invalid' {
  const trimmed = reply.trim();
  // A real filter name wins over the generic cancellation word list — otherwise a filter
  // literally named "Stop" or "Cancel" could never be selected by name.
  const byName = filters.find(f => f.name.toLowerCase() === trimmed.toLowerCase());
  if (byName) return byName;
  if (isCancellation(reply)) return 'cancel';
  const byIndex = trimmed.match(/^(\d+)$/);
  if (byIndex) {
    const n = parseInt(byIndex[1], 10);
    if (n >= 1 && n <= filters.length) return filters[n - 1];
    return 'invalid';
  }
  return 'invalid';
}

// U3 (favourite/filter search): "show my filters"'s numbered pick-list session — parallel to
// FilterSelectionSession (which is reached via a specific filterId/filterName match), but reached
// via getMyFilters()'s combined favourites+owned listing instead of a name/id search. No
// `originalPrompt` field (FilterSelectionSession's copy of it is unused by any caller today) —
// this session only ever needs the filter list itself to resolve a pick.
export interface ListedFiltersSession {
  filters: JiraFilter[];
}

/** Resolves a reply to `listMyFilters`'s numbered pick-list the same way `parseFilterSelection`
 * resolves `FilterSelectionSession`'s — delegating to it directly so both sessions share the same
 * exact-match-before-cancellation-word ordering (a filter literally named "Stop" or "Cancel" must
 * still be selectable by exact name; see parseFilterSelection's own doc comment). */
export function parseListedFiltersSelection(reply: string, session: ListedFiltersSession): JiraFilter | 'cancel' | 'invalid' {
  return parseFilterSelection(reply, session.filters);
}

export function parseSkippedAttachmentSelection(
  reply: string,
  count: number,
): number[] | 'out-of-range' | 'not-a-selection' {
  // Strip optional leading "download" keyword
  const stripped = reply.trim().replace(/^download\s+/i, '');
  // Split by whitespace and commas; each token must be a pure integer
  const tokens = stripped.split(/[\s,]+/).filter(Boolean);
  if (tokens.length === 0) return 'not-a-selection';
  if (tokens.some(t => !/^\d+$/.test(t))) return 'not-a-selection';
  const numbers = tokens.map(t => parseInt(t, 10));
  if (numbers.some(n => n < 1 || n > count)) return 'out-of-range';
  return [...new Set(numbers)].sort((a, b) => a - b);
}

export function rewriteAttachmentLinks(
  md: string,
  downloaded: Set<string>,           // filename → rewrite href to attachments/filename
  skippedUrls: Map<string, string>,   // filename → full Jira contentUrl
): string {
  return md.replace(/\[([^\]]*)\]\(([^)]+)\)/g, (match, alt, href) => {
    if (downloaded.has(href)) return `[${alt}](attachments/${href})`;
    const jiraUrl = skippedUrls.get(href);
    if (jiraUrl) return `[${alt}](${jiraUrl})`;
    return match;
  });
}

export type EmailOptionPick =
  | { kind: 'template'; name: string; issueType: string }
  | { kind: 'type'; issueType: string };

export function pickEmailOption(
  n: number,
  templates: Array<{ name: string; issueType: string }>,
  issueTypes: string[],
): EmailOptionPick | null {
  if (n < 1 || n > templates.length + issueTypes.length) return null;
  if (n <= templates.length) {
    const t = templates[n - 1];
    return { kind: 'template', name: t.name, issueType: t.issueType };
  }
  return { kind: 'type', issueType: issueTypes[n - templates.length - 1] };
}

export interface BulkUpdateReviewRow {
  key: string;
  summary: string;
  currentValueDisplay: string;
  // U6/KTD6: mirrors ReviewRowBase's `included` convention — whether this ticket is updated if the
  // batch runs. Defaults to true at construction (JiraParticipant.ts); toggled per-row (R8) by this
  // table's own Update? column and parseBulkUpdateReview()'s key-list toggle.
  included: boolean;
}

// Summary/current-value are untrusted, externally-influenced Jira field content — this table's
// composed response is trust-gated (KTD5) at its call site (JiraParticipant.ts), so both go
// through neutralizeMarkdownLinks() (see its own doc comment).
const BULK_UPDATE_REVIEW_COLUMNS: ReviewTableColumn<BulkUpdateReviewRow>[] = [
  { header: 'Key', accessor: (r) => r.key },
  { header: 'Summary', accessor: (r) => neutralizeMarkdownLinks(r.summary) },
  { header: 'Current value', accessor: (r) => neutralizeMarkdownLinks(r.currentValueDisplay) },
  // R8/R9: positive "will update when checked" framing — clicking resubmits this row's own key,
  // the exact text parseBulkUpdateReview() already accepts as a toggle (bare key list), so no new
  // parser shape beyond what KTD6 already calls for.
  { header: 'Update?', accessor: (r) => buildChatCommandLink(r.included ? '✓' : '_excluded_', '@jira', r.key) },
];

/**
 * Renders the bulk field-update review table. The caller (JiraParticipant.ts) is responsible for
 * resolving each row's "current value" display via TicketService's renderFieldValue() — this
 * wrapper only renders already-computed, simple row data (KTD3).
 */
export function buildBulkUpdateReviewTable(rows: BulkUpdateReviewRow[]): string {
  return renderReviewTable(BULK_UPDATE_REVIEW_COLUMNS, rows);
}

// U6/AE4: flips `included` for every row whose key is in `keys` — pure so it's independently
// testable, mirroring applyReviewToggle()/applyTicketToggle()'s shape for the other review tables.
export function applyBulkUpdateToggle(rows: BulkUpdateReviewRow[], keys: string[]): BulkUpdateReviewRow[] {
  const toggleSet = new Set(keys.map(k => k.toUpperCase()));
  return rows.map(r => (toggleSet.has(r.key.toUpperCase()) ? { ...r, included: !r.included } : r));
}

export type ReviewParseResult =
  | { action: 'ok' }
  | { action: 'cancel' }
  | { action: 'toggle'; ids: string[] }
  | { action: 'setValue'; id: string; value: string }
  | { action: 'invalid' };

export function parseReviewInput(reply: string, rowIds: string[]): ReviewParseResult {
  const trimmedOriginal = reply.trim();
  const normalized = trimmedOriginal.toLowerCase();
  if (isConfirmation(reply)) return { action: 'ok' };
  if (isCancellation(reply)) return { action: 'cancel' };

  // A single `<row-id>=<value>` reply sets that row's value without toggling it (used by
  // the template-generation review list to fill in a no-reference field with nothing to copy).
  // Checked against the ORIGINAL casing/spacing (not `normalized`) so the value half survives
  // exactly as typed — a Jira display value like "High" must not become "high". Splitting only
  // on the first '=' (rather than tokenizing on whitespace first) lets the value itself contain
  // spaces (e.g. `3=Needs review`). This is purely additive: a reply with no '=' at all — every
  // existing caller's toggle/ok/cancel/invalid input — never reaches this branch, and a reply
  // with '=' whose left-hand side doesn't match a known row id falls through unchanged to the
  // existing tokenizing/toggle logic below (so a field value that happens to contain '=' but
  // doesn't look like `<id>=...` still gets the old 'invalid' behavior, not a new failure mode).
  const eqIndex = trimmedOriginal.indexOf('=');
  if (eqIndex > 0) {
    const idPart = trimmedOriginal.slice(0, eqIndex).trim();
    const valuePart = trimmedOriginal.slice(eqIndex + 1).trim();
    if (idPart.length > 0 && !/\s/.test(idPart) && valuePart.length > 0) {
      const foundId = rowIds.find(id => id.toLowerCase() === idPart.toLowerCase());
      if (foundId) return { action: 'setValue', id: foundId, value: valuePart };
    }
  }

  const tokens = normalized.split(/[\s,]+/).filter(Boolean);
  const matched: string[] = [];
  for (const token of tokens) {
    const found = rowIds.find(id => id.toLowerCase() === token);
    if (found) matched.push(found);
  }
  if (matched.length === 0) return { action: 'invalid' };
  return { action: 'toggle', ids: matched };
}

// Pure so it's independently testable — the vscode-dependent handler just calls this and
// re-streams the result, rather than mutating row objects in place.
export function applyReviewToggle<TRow extends { id: string; included: boolean }>(rows: TRow[], ids: string[]): TRow[] {
  const toggleSet = new Set(ids);
  return rows.map(r => (toggleSet.has(r.id) ? { ...r, included: !r.included } : r));
}

// Pure so it's independently testable alongside applyReviewToggle — sets one row's value without
// touching `included` (the `<id>=<value>` reply is a value-set, not a toggle).
export function applyReviewSetValue<TRow extends { id: string; value: unknown }>(rows: TRow[], id: string, value: unknown): TRow[] {
  return rows.map(r => (r.id === id ? { ...r, value } : r));
}
