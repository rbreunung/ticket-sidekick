import type { JiraComment, JiraFieldMeta, JiraFilter, JiraSprintCandidate } from '../jira/IJiraClient';
import { formatJiraBody } from '../utils/markdownFormatter';
import type { VeracodeFlaw, VeracodeReviewRow } from '../utils/veracodeReport';
import type { WaltzComponent, WaltzReviewRow } from '../utils/waltzReport';
import { BATCH_LIMIT, sanitizeCellText } from '../utils/reportImport';
import { formatKeyLink, type TemplateFieldCandidate } from '../services/TicketService';
import type { JiraTemplate } from '../templates/TemplateService';

export type { VeracodeReviewRow } from '../utils/veracodeReport';
export type { WaltzReviewRow } from '../utils/waltzReport';

export interface CreationSession {
  template: string;
  project: string;
  summary: string | null;
  issueType: string;
  allSections: string[];
  pending: string[];
  answers: Record<string, string>;
  fields: Record<string, unknown>;
}

export type ContentSession =
  | {
      operation: 'addComment' | 'updateDescription';
      ticketKey: string;
      currentContent: string;
      historyContext: string | undefined;
      contentSource: 'generate' | 'history-recent' | 'history-full';
    }
  | {
      operation: 'createTicket';
      projectKey: string;
      summary: string;
      issueType: string;
      templateName: string | null;
      extraFields: Record<string, unknown>;
      currentContent: string;
    };

export interface MoreCommentsSession {
  ticketKey: string;
  commentQuery: string | null;
  displayMode?: 'full' | 'synthesize';
}

export interface CommentListSession {
  ticketKey: string;
  comments: Array<{
    index: number;
    author: string;
    date: string;
    bodyMarkdown: string;
  }>;
}

export interface CreateSelectionSession {
  templates: Array<{ name: string; issueType: string }>;
  issueTypes: string[];
  projectKey: string;
  summary: string | null;
  description: string | null;
  extraFields?: Record<string, unknown>;
  originalPrompt: string;
}

export interface TransitionSubtask {
  key: string;
  summary: string;
  currentStatus: string;
  transitionPath: Array<{ id: string; name: string; to: string }>;
  resolution?: string;
}

export interface TransitionBatchTicket {
  key: string;
  summary: string;
  currentStatus: string;
  transitionPath: Array<{ id: string; name: string; to: string }>;
  subtasks: TransitionSubtask[];
}

export interface TransitionBatchSession {
  tickets: TransitionBatchTicket[];
  resolution: string | undefined;
  ruleName: string | undefined;
  issueType: string;
}

interface TransitionReviewRow {
  type: string;
  key: string;
  summary: string;
  currentStatus: string;
  to: string;
  resolution: string;
}

export function buildReviewTable(session: TransitionBatchSession): string {
  const hasResolution = session.resolution !== undefined;

  const sorted = [...session.tickets].sort((a, b) =>
    a.currentStatus.toLowerCase().localeCompare(b.currentStatus.toLowerCase()),
  );

  const flatRows: TransitionReviewRow[] = [];
  for (const t of sorted) {
    flatRows.push({
      type: session.issueType,
      key: t.key,
      summary: t.summary,
      currentStatus: t.currentStatus,
      to: t.transitionPath.at(-1)?.to ?? '?',
      resolution: session.resolution ?? '',
    });
    for (const s of t.subtasks) {
      flatRows.push({
        type: 'Sub-task',
        key: `↳ ${s.key}`,
        summary: s.summary,
        currentStatus: s.currentStatus,
        to: s.transitionPath.at(-1)?.to ?? '?',
        resolution: s.resolution ?? session.resolution ?? '',
      });
    }
  }

  const columns: ReviewTableColumn<TransitionReviewRow>[] = [
    { header: 'Type', accessor: (r) => r.type },
    { header: 'Key', accessor: (r) => r.key },
    { header: 'Summary', accessor: (r) => r.summary },
    { header: 'From', accessor: (r) => r.currentStatus },
    { header: '→ To', accessor: (r) => r.to },
    ...(hasResolution
      ? [{ header: 'Resolution', accessor: (r: TransitionReviewRow) => r.resolution }]
      : []),
  ];

  return renderReviewTable(columns, flatRows) + '\n\npost it · (c) · key numbers to skip (e.g. 11 14)';
}

export interface ResolutionSelectionSession {
  tickets: TransitionBatchTicket[];
  ruleName: string | undefined;
  issueType: string;
  targetState: string;
  resolutionOptions: string[];
}

export type SkipParseResult =
  | { action: 'ok' }
  | { action: 'cancel' }
  | { action: 'skip'; keys: string[] }
  | { action: 'invalid' };

export interface EmailContentSession {
  emailId: string;
  subject: string;
  senderName?: string;
  receivedDateTime?: string;
  markdownBody: string;
  inlineImageMap: Record<string, string>;
  attachments: Array<{
    name: string; contentType: string; contentBytes: string;
    isInline: boolean; contentId?: string;
  }>;
  emlFilePath?: string;
  selectedTemplateName: string | null;
  projectKey: string;
  issueType: string;
  additionalFields: Record<string, unknown>;
  availableTemplates?: Array<{ name: string; issueType: string }>;
  availableIssueTypes?: string[];
  pendingCommentTicketKey?: string;
}

export function parseSkipInput(reply: string, tickets: TransitionBatchTicket[]): SkipParseResult {
  const normalized = reply.trim().toLowerCase();
  if (isConfirmation(reply)) return { action: 'ok' };
  if (isCancellation(reply)) return { action: 'cancel' };

  const parts = normalized.split(/\s+/).filter(Boolean);
  const allKeys = new Map<string, string>(); // numeric suffix → full key
  for (const t of tickets) {
    allKeys.set(t.key.split('-')[1], t.key);
    for (const s of t.subtasks) allKeys.set(s.key.split('-')[1], s.key);
  }

  const mentioned = new Set<string>();
  for (const p of parts) {
    const key = allKeys.get(p);
    if (key) mentioned.add(key);
  }
  if (mentioned.size === 0) return { action: 'invalid' };

  // Cascade: subtask mentioned → also skip parent; parent mentioned → also skip all subtasks
  const expanded = new Set(mentioned);
  for (const t of tickets) {
    if (mentioned.has(t.key)) {
      for (const s of t.subtasks) expanded.add(s.key);
    }
    for (const s of t.subtasks) {
      if (mentioned.has(s.key)) expanded.add(t.key);
    }
  }
  return { action: 'skip', keys: [...expanded] };
}

export function parseResolutionSelection(reply: string, options: string[]): string | null | 'invalid' {
  const normalized = reply.trim().toLowerCase();
  if (normalized === 'none' || normalized === 'skip') return null;
  const num = parseInt(normalized, 10);
  if (!isNaN(num) && num >= 1 && num <= options.length) return options[num - 1];
  const match = options.find((o) => o.toLowerCase() === normalized);
  return match ?? 'invalid';
}

export function extractLastTicketFromText(text: string): string | null {
  const match = text.match(/<!--\s*@jira-ticket:([A-Z][A-Z0-9]+-\d+)\s*-->/);
  return match ? match[1] : null;
}

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

export function isConfirmation(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  const CONFIRMATIONS = new Set([
    'yes', 'yep', 'ok', 'okay', 'sure', 'perfect', 'great',
    'looks good', 'looks great', 'go ahead', 'do it', 'ship it',
    'post it', 'post', 'confirm', 'confirmed', 'submit', 'approved', 'approve', 'fine',
    'load all', 'load more', 'show all', 'show more', 'create it',
  ]);
  return CONFIRMATIONS.has(normalized);
}

export function isCancellation(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  const CANCELLATIONS = new Set([
    'c', 'no', 'nope', 'cancel', 'cancelled', 'stop', 'abort',
    'never mind', 'nevermind', "don't", 'dont', 'quit', 'skip',
  ]);
  return CANCELLATIONS.has(normalized);
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
}

export interface SearchResultSession {
  ticketKeys: string[];
  jql: string;
}

export interface BulkUpdateReviewSession {
  ticketKeys: string[];
  fieldId: string;
  fieldName: string;
  fieldValue: unknown;
  arrayOp: 'set' | 'add' | 'remove';
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

export function parseBulkUpdateReview(reply: string): { action: 'ok'; skip: string[] } | { action: 'cancel' } | { action: 'invalid' } {
  const trimmed = reply.trim();
  if (!trimmed) return { action: 'invalid' };
  if (isCancellation(reply)) return { action: 'cancel' };
  if (isConfirmation(reply)) return { action: 'ok', skip: [] };
  const skipMatch = trimmed.match(/^skip\s+(.*)/i);
  if (skipMatch) {
    const keys = skipMatch[1].trim().split(/[\s,]+/).filter(Boolean);
    return { action: 'ok', skip: keys };
  }
  return { action: 'invalid' };
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

export interface LoadSkippedSession {
  ticketKey: string;
  skipped: Array<{
    filename: string;
    content: string;  // Jira download URL
    size: number;
    mimeType: string;
    reason: string;
  }>;
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

export function selectDefaultIssueType(issueTypes: string[]): string {
  return (
    issueTypes.find(t => t === 'Story') ??
    issueTypes.find(t => t === 'Task') ??
    issueTypes[0] ??
    'Story'
  );
}

export function buildTeamJql(teamJql: string, extraJql: string | null): string {
  const extra = extraJql ? ` AND (${extraJql})` : ' AND resolution is NULL';
  return `(${teamJql})${extra}`;
}

// ---------------------------------------------------------------------------------------------
// Shared Veracode/Waltz import session types + review-table renderer + toggle-reply parser.
//
// Both importers (Veracode flaws, Waltz OSS components) drive the same session flow: pick a
// template/issue-type → dedup-search already-ticketed items → show a review table the user can
// toggle rows on/off in → create tickets for the included rows. Only the parser, per-row
// label/summary/description building, and config live in each importer's own file
// (veracodeReport.ts/veracodeHandler.ts vs waltzReport.ts/waltzHandler.ts) — everything about the
// session shape and the review screen itself is generic and lives here (R1/R10).
// ---------------------------------------------------------------------------------------------

// Bumped whenever the session shape changes in a way that would make an in-flight (already
// persisted) session render incorrectly if fed straight to the current code. A session written by
// a build that predates this field entirely reads as `undefined`, which isSessionExpired() also
// treats as expired — see AE7.
export const CURRENT_SESSION_SCHEMA_VERSION = 1;

export interface ImportTemplateSelectionSession<TItem> {
  reportFileName: string;
  projectKey: string;
  items: TItem[]; // already filtered by the importer's own config (severity/rating, status/action, etc.)
  availableTemplates: Array<{ name: string; issueType: string }>;
  availableIssueTypes: string[];
  schemaVersion: number;
}

export type VeracodeTemplateSelectionSession = ImportTemplateSelectionSession<VeracodeFlaw>;
export type WaltzTemplateSelectionSession = ImportTemplateSelectionSession<WaltzComponent>;

export interface ReviewRowBase {
  id: string; // '1'..'N' new candidates, 'A1'..'Am' already-ticketed
  existingTicketKey: string | null;
  included: boolean; // whether this row will be (re)created if the batch runs
}

export interface ReviewSession<TRow> {
  projectKey: string;
  issueType: string;
  templateName: string | null;
  additionalFields: Record<string, unknown>; // resolved template fields (labels merged in per-row already)
  rows: TRow[];
  // Total new (not-yet-ticketed) items the report matched, before any BATCH_LIMIT cap the importer
  // applies before building `rows`. Harmless as absent/undefined for an importer that doesn't cap —
  // buildImportReviewTable() only renders the "more matched" note when it's given and exceeds rows shown.
  totalNewMatched?: number;
  schemaVersion: number;
}

export type VeracodeReviewSession = ReviewSession<VeracodeReviewRow>;
export type WaltzReviewSession = ReviewSession<WaltzReviewRow>;

/**
 * A stored session written before `schemaVersion` existed (reads back as `undefined`) — or by an
 * older build than this one understands — may be missing fields the current renderer/handler
 * expects. Treating it as expired here (rather than rendering `undefined` cells or running a batch
 * against incomplete data) is what AE7 requires. "No session at all" is a different, already-handled
 * case and is deliberately NOT reported as expired by this guard.
 */
export function isSessionExpired(session: { schemaVersion?: number } | null | undefined): boolean {
  if (!session) return false;
  return typeof session.schemaVersion !== 'number' || session.schemaVersion < CURRENT_SESSION_SCHEMA_VERSION;
}

export const SESSION_EXPIRED_MESSAGE =
  '_This import session was started before a Ticket Sidekick update and can no longer be continued — please re-run the import._';

export interface ReviewTableColumn<TRow> {
  header: string;
  accessor: (row: TRow) => string;
}

/**
 * Renders one markdown table — header row, a standardized dash separator row, and one data row
 * per input row — from a column descriptor list and a flat row list.
 *
 * Presentation-only: it has no opinion on sanitization, truncation, row grouping/sections, skip
 * vs. toggle reply semantics, or session expiry — those all stay caller concerns. A multi-section
 * screen (e.g. "already ticketed" vs. "new") is composed by the caller invoking this once per
 * section — passing that section's own column array, which may include section-specific extra
 * columns (e.g. a "Ticket" column) — and prepending its own section heading before each call's
 * output. Holds no state between calls.
 */
export function renderReviewTable<TRow>(columns: ReviewTableColumn<TRow>[], rows: TRow[]): string {
  const headerRow = `| ${columns.map(c => c.header).join(' | ')} |`;
  const separatorRow = `| ${columns.map(() => '---').join(' | ')} |`;
  const dataRows = rows.map(row => `| ${columns.map(c => c.accessor(row)).join(' | ')} |`);
  return [headerRow, separatorRow, ...dataRows].join('\n');
}

export const VERACODE_REVIEW_COLUMNS: ReviewTableColumn<VeracodeReviewRow>[] = [
  { header: 'Severity', accessor: (r) => `${r.severityLabelText} (${r.severity})` },
  { header: 'CWE', accessor: (r) => (r.cweId ? `CWE-${r.cweId}` : '—') },
  { header: 'Summary', accessor: (r) => r.summary },
];

export const WALTZ_REVIEW_COLUMNS: ReviewTableColumn<WaltzReviewRow>[] = [
  { header: 'Component', accessor: (r) => r.nameVersion },
  { header: 'Rating', accessor: (r) => r.maxVulnRating },
];

// Aliased locally rather than threading BATCH_LIMIT through as an extra buildImportReviewTable param.
const REVIEW_BATCH_LIMIT = BATCH_LIMIT;

export function buildImportReviewTable<TRow extends ReviewRowBase>(
  rows: TRow[],
  baseUrl: string | undefined,
  totalNewMatched: number | undefined,
  columns: ReviewTableColumn<TRow>[],
  itemNoun: string, // e.g. 'flaw(s)' or 'component(s)' — used in summary/truncation lines
): string {
  const ticketed = rows.filter(r => r.existingTicketKey !== null);
  const fresh = rows.filter(r => r.existingTicketKey === null);
  const lines: string[] = [];
  const idColumn: ReviewTableColumn<TRow> = { header: '#', accessor: (r) => r.id };
  const pluralBare = itemNoun.replace('(s)', 's'); // 'component(s)' -> 'components'

  if (ticketed.length > 0) {
    const ticketedColumns: ReviewTableColumn<TRow>[] = [
      idColumn,
      ...columns,
      { header: 'Ticket', accessor: (r) => formatKeyLink(r.existingTicketKey!, baseUrl) },
      { header: 'Include?', accessor: (r) => (r.included ? '✓ re-create' : '_excluded_') },
    ];
    lines.push('### Already ticketed');
    lines.push(renderReviewTable(ticketedColumns, ticketed));
    lines.push('');
  }

  lines.push('### New — will create');
  if (fresh.length === 0) {
    lines.push(`_All matching ${pluralBare} already have a ticket._`);
  } else {
    const freshColumns: ReviewTableColumn<TRow>[] = [
      idColumn,
      ...columns,
      { header: 'Include?', accessor: (r) => (r.included ? '✓' : '_excluded_') },
    ];
    lines.push(renderReviewTable(freshColumns, fresh));
  }
  lines.push('');

  // Row-count truncation note: an importer that caps "new" rows before they ever reach this table
  // (e.g. Waltz's BATCH_LIMIT) would otherwise silently drop the remainder with no signal. Surfacing
  // the true total here, plus how to get the rest, closes that gap — and reuses the existing dedup
  // mechanism as the "resume" path (re-running after this batch completes surfaces the next batch of
  // new candidates, since the ones just created are now dedup-matched).
  if (totalNewMatched !== undefined && totalNewMatched > fresh.length) {
    lines.push(
      `_${totalNewMatched - fresh.length} more matched ${itemNoun} not shown — re-run the import after ` +
      `this batch completes; already-created tickets are automatically skipped next time._`,
    );
    lines.push('');
  }

  const willCreate = rows.filter(r => r.included).length;
  lines.push(`**${willCreate}** ticket(s) will be created.`);
  // Defensive backstop: "new" rows may already be capped upstream, but a user can still toggle extra
  // "already ticketed" rows back to "re-create", so this can still fire even with an upstream cap.
  if (willCreate > REVIEW_BATCH_LIMIT) {
    lines.push('');
    lines.push(`_Only the first ${REVIEW_BATCH_LIMIT} included rows will be created this run — re-run the import afterward for the remainder._`);
  }
  lines.push('');
  lines.push('Reply **post it** to proceed, **(c)** to cancel, or a list of ids to toggle (e.g. `2 4` or `A1`).');

  return lines.join('\n');
}

export interface BulkUpdateReviewRow {
  key: string;
  summary: string;
  currentValueDisplay: string;
}

const BULK_UPDATE_REVIEW_COLUMNS: ReviewTableColumn<BulkUpdateReviewRow>[] = [
  { header: 'Key', accessor: (r) => r.key },
  { header: 'Summary', accessor: (r) => r.summary },
  { header: 'Current value', accessor: (r) => r.currentValueDisplay },
];

/**
 * Renders the bulk field-update review table. The caller (JiraParticipant.ts) is responsible for
 * resolving each row's "current value" display via TicketService's renderFieldValue() — this
 * wrapper only renders already-computed, simple row data (KTD3).
 */
export function buildBulkUpdateReviewTable(rows: BulkUpdateReviewRow[]): string {
  return renderReviewTable(BULK_UPDATE_REVIEW_COLUMNS, rows);
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

  // KTD5: a single `<row-id>=<value>` reply sets that row's value without toggling it (used by
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
// touching `included` (KTD5's `<id>=<value>` reply is a value-set, not a toggle).
export function applyReviewSetValue<TRow extends { id: string; value: unknown }>(rows: TRow[], id: string, value: unknown): TRow[] {
  return rows.map(r => (r.id === id ? { ...r, value } : r));
}

// ---------------------------------------------------------------------------------------------
// Template generation (U4) — the multi-turn flow that turns a reference ticket's template-shaped
// fields, or (with no reference) a project's required-fields create-metadata, into a reviewed,
// saved `.jira-templates.json` template. Reuses the shared renderReviewTable/parseReviewInput
// primitives above (R3) plus the KTD5 `<row-id>=<value>` reply form for filling in a
// no-reference row's still-empty value inline, without a separate multi-turn detour. All
// `vscode`-coupled orchestration (streaming, workspaceState, calling TicketService/TemplateService)
// lives in `templateGenerationHandler.ts`; only pure session shapes/helpers live here so they stay
// Vitest-loadable.
// ---------------------------------------------------------------------------------------------

// Jira's required-fields create-metadata (the no-reference path's source, TicketService's
// getTemplateCandidatesFromRequiredFields) is not filtered by TicketService's KTD1 allowlist the
// way the reference-ticket path is — it returns every field the issue type's create screen
// requires, which routinely includes fields that are never template data: summary/description are
// per-ticket content, and project/issuetype/reporter are already resolved elsewhere in this flow.
// Filtered out here (not in TicketService) since it's specific to how this handler presents the
// no-reference candidate list, not a general rule TicketService's other callers need.
const PER_TICKET_FIELD_IDS = new Set(['summary', 'description', 'issuetype', 'project', 'reporter']);

export function filterOutPerTicketFields(candidates: TemplateFieldCandidate[]): TemplateFieldCandidate[] {
  return candidates.filter(c => !PER_TICKET_FIELD_IDS.has(c.id));
}

/** One row of the template-generation review list. `id` is a short display index ('1'..'N'),
 * matching the existing review-row convention (Veracode/Waltz's `id` is likewise a display index,
 * not the underlying identity) — `fieldId` carries the real Jira field id that gets written into
 * `defaultFields`. `value` is `undefined` when there's nothing to show yet (a no-reference row
 * before the user fills it in via `<id>=<value>`, per KTD5). */
export interface TemplateFieldReviewRow {
  id: string;
  fieldId: string;
  name: string;
  value: unknown;
  included: boolean;
}

export function buildTemplateFieldReviewRows(candidates: TemplateFieldCandidate[]): TemplateFieldReviewRow[] {
  return candidates.map((c, i) => ({
    id: String(i + 1),
    fieldId: c.id,
    name: c.name,
    value: c.value,
    included: true,
  }));
}

// Renders a candidate value for the review table. Objects/arrays are unwrapped to their most
// display-relevant piece (a `name`, an `id`, or a joined list) rather than shown as raw JSON —
// mirrors the shapes README's template examples document (`{ name: "High" }`, `[{ name: "Backend" }]`).
export function formatTemplateFieldValue(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(formatTemplateFieldValue).join(', ');
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (typeof obj.name === 'string') return obj.name;
    if (obj.id !== undefined) return String(obj.id);
    return JSON.stringify(obj);
  }
  return String(value);
}

export const TEMPLATE_FIELD_REVIEW_COLUMNS: ReviewTableColumn<TemplateFieldReviewRow>[] = [
  { header: '#', accessor: (r) => r.id },
  { header: 'Field', accessor: (r) => sanitizeCellText(r.name) },
  {
    header: 'Value',
    accessor: (r) => r.value === undefined
      ? `_not set — reply \`${r.id}=<value>\`_`
      : sanitizeCellText(formatTemplateFieldValue(r.value)),
  },
  { header: 'Include?', accessor: (r) => (r.included ? '✓' : '_excluded_') },
];

export function buildTemplateFieldReviewTable(rows: TemplateFieldReviewRow[]): string {
  return renderReviewTable(TEMPLATE_FIELD_REVIEW_COLUMNS, rows) +
    '\n\nReply **post it** to save, **(c)** to cancel, row numbers to toggle in/out (e.g. `2 4`), ' +
    'or `<number>=<value>` to set a value (e.g. `3=High`).';
}

/** Rows still included but with no value filled in. A confirm ("post it") must not silently save
 * a required field as blank, and must not silently drop it from the template either — the caller
 * re-prompts for these instead of proceeding to save. */
export function findUnsetIncludedRows(rows: TemplateFieldReviewRow[]): TemplateFieldReviewRow[] {
  return rows.filter(r => r.included && r.value === undefined);
}

/** Builds the literal `defaultFields` map (KTD2 — never `resolveFields`) from the reviewed rows.
 * Only included rows with a resolved value contribute; call findUnsetIncludedRows() first so an
 * included-but-still-unset row never reaches here silently. */
export function buildDefaultFieldsFromRows(rows: TemplateFieldReviewRow[]): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const row of rows) {
    if (!row.included || row.value === undefined) continue;
    fields[row.fieldId] = row.value;
  }
  return fields;
}

export function buildGeneratedTemplate(templateName: string, issueType: string, rows: TemplateFieldReviewRow[]): JiraTemplate {
  return {
    name: templateName,
    issueType,
    defaultFields: buildDefaultFieldsFromRows(rows),
  };
}

/** Derives a project key from a reference ticket key (e.g. `PROJ-123` -> `PROJ`) — used on the
 * reference-ticket generation path so the user isn't asked for a project key the ticket key
 * already implies. Returns null for anything that doesn't look like a real ticket key. */
export function extractProjectKeyFromTicketKey(ticketKey: string): string | null {
  const match = ticketKey.trim().match(/^([A-Z][A-Z0-9]+)-\d+$/);
  return match ? match[1] : null;
}

/** Parses a reply to the KTD6 "pick an issue type" list (no-reference path, no type named) — by
 * number or by exact (case-insensitive) name. */
export function parseIssueTypePick(reply: string, issueTypes: string[]): string | 'cancel' | 'invalid' {
  if (isCancellation(reply)) return 'cancel';
  const trimmed = reply.trim();
  const n = parseInt(trimmed, 10);
  if (!isNaN(n) && String(n) === trimmed && n >= 1 && n <= issueTypes.length) return issueTypes[n - 1];
  const byName = issueTypes.find(t => t.toLowerCase() === trimmed.toLowerCase());
  return byName ?? 'invalid';
}

export type TemplateCollisionReply =
  | { action: 'cancel' }
  | { action: 'overwrite' }
  | { action: 'rename'; name: string }
  | { action: 'invalid' };

/** Parses the R6 name-collision reply: cancel the whole flow, explicitly confirm overwriting the
 * existing template, or give a different name to retry the save under (the reviewed field set is
 * preserved by the caller across this reply — see TemplateGenerationCollisionSession). */
export function parseTemplateCollisionReply(reply: string): TemplateCollisionReply {
  if (isCancellation(reply)) return { action: 'cancel' };
  if (isConfirmation(reply)) return { action: 'overwrite' };
  const name = reply.trim();
  if (name.length === 0) return { action: 'invalid' };
  return { action: 'rename', name };
}

export type OfferCreateReply =
  | { action: 'decline' }
  | { action: 'needSummary' }
  | { action: 'create'; summary: string };

/** Parses the R7 "create a first ticket?" reply. A bare confirmation word ("yes") has no summary
 * in it yet, so it's distinguished from a reply that supplies the summary directly in one turn —
 * both are accepted so the flow doesn't force an extra round-trip when the user just answers with
 * the summary up front. */
export function parseOfferCreateReply(reply: string): OfferCreateReply {
  if (isCancellation(reply)) return { action: 'decline' };
  if (isConfirmation(reply)) return { action: 'needSummary' };
  const trimmed = reply.trim();
  if (trimmed.length === 0) return { action: 'decline' };
  return { action: 'create', summary: trimmed };
}

// --- Session shapes, workspaceState-persisted across turns. Keys/tags live in
// templateGenerationHandler.ts (the vscode-coupled layer that reads/writes workspaceState). ---

export interface TemplateGenerationTypePickSession {
  templateName: string;
  projectKey: string;
  availableIssueTypes: string[];
  schemaVersion: number;
}

export interface TemplateGenerationReviewSession {
  templateName: string;
  projectKey: string;
  issueType: string;
  sourceTicketKey: string | null;
  rows: TemplateFieldReviewRow[];
  schemaVersion: number;
}

export interface TemplateGenerationCollisionSession {
  template: JiraTemplate; // fully-built, pending save — `template.name` is the attempted/colliding name
  projectKey: string;
  schemaVersion: number;
}

export interface TemplateGenerationOfferCreateSession {
  template: JiraTemplate; // just-saved template
  projectKey: string;
  schemaVersion: number;
}

export interface TemplateGenerationAwaitSummarySession {
  template: JiraTemplate;
  projectKey: string;
  schemaVersion: number;
}

