import type { JiraComment, JiraFieldMeta, JiraFilter, JiraSprintCandidate } from '../jira/IJiraClient';
import { formatJiraBody } from '../utils/markdownFormatter';
import type { VeracodeFlaw, VeracodeReviewRow } from '../utils/veracodeReport';
import type { WaltzComponent, WaltzReviewRow } from '../utils/waltzReport';
import { BATCH_LIMIT, sanitizeCellText } from '../utils/reportImport';
import { formatKeyLink, coerceTypedFieldValue, type TemplateFieldCandidate } from '../services/TicketService';
import type { JiraTemplate } from '../templates/TemplateService';
// Type-only — ConfigService.ts imports `vscode`, but a type-only import is erased before
// this (vscode-free, Vitest-loadable) module is ever loaded at runtime.
import type { JiraConfig } from '../services/ConfigService';
import type { WorkflowGraph } from '../services/WorkflowService';

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

// Shared by parseResolutionSelection and parseIssueTypePick: resolves a reply to one list item
// by 1-based number or by exact case-insensitive name. The `String(n) === trimmed` guard rejects
// a partially-numeric string like "1abc" rather than letting parseInt silently truncate it into
// a match. Returns undefined when neither form matches.
function pickByNumberOrName(reply: string, options: string[]): string | undefined {
  const trimmed = reply.trim();
  const n = parseInt(trimmed, 10);
  if (!isNaN(n) && String(n) === trimmed && n >= 1 && n <= options.length) return options[n - 1];
  return options.find(o => o.toLowerCase() === trimmed.toLowerCase());
}

export function parseResolutionSelection(reply: string, options: string[]): string | null | 'invalid' {
  const normalized = reply.trim().toLowerCase();
  if (normalized === 'none' || normalized === 'skip') return null;
  return pickByNumberOrName(reply, options) ?? 'invalid';
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

// The "no resolvable issue type" sentinel — never a real Jira issue type name. Signals that
// nothing was fetched or configured, so the caller must ask the user rather than guess.
export const NO_ISSUE_TYPE = '';

export function selectDefaultIssueType(issueTypes: string[]): string {
  return (
    issueTypes.find(t => t === 'Story') ??
    issueTypes.find(t => t === 'Task') ??
    issueTypes[0] ??
    NO_ISSUE_TYPE
  );
}

// Resolves a template's own configured issue type, falling back to the first fetched project
// issue type, or the never-guess sentinel when neither is available.
export function resolveTemplateIssueType(explicit: string | undefined, issueTypes: string[]): string {
  return explicit ?? issueTypes[0] ?? NO_ISSUE_TYPE;
}

// Renders a template/type-list entry, replacing the never-guess sentinel with an explicit
// "you'll be asked to type it" indicator instead of a blank or fabricated-looking value.
export function formatIssueTypeOptionLabel(issueType: string): string {
  return issueType === NO_ISSUE_TYPE ? '_you will be asked to type it_' : issueType;
}

// Same sentinel, for the inline "as **Bug**" phrasing used outside numbered lists.
export function formatIssueTypeInlinePhrase(issueType: string): string {
  return issueType === NO_ISSUE_TYPE ? formatIssueTypeOptionLabel(issueType) : `**${issueType}**`;
}

export function buildTeamJql(teamJql: string, extraJql: string | null): string {
  const extra = extraJql ? ` AND (${extraJql})` : ' AND resolution is NULL';
  return `(${teamJql})${extra}`;
}

/**
 * Plain-text "Jira isn't configured" message naming the specific missing setting or setup
 * command — the same information @jira's chat handler's own not-configured messages give,
 * but without a trusted `MarkdownString` command link (a `LanguageModelToolResult`, unlike a
 * chat stream, can't carry one), so this doubles as both a tool result and plain chat text.
 */
export function buildJiraNotConfiguredMessage(config: Pick<JiraConfig, 'baseUrl' | 'token' | 'authType'>): string {
  if (!config.baseUrl) {
    return (
      'Jira base URL not configured. Add `ticketSidekick.jira.baseUrl` in VS Code settings ' +
      '(e.g. `https://jira.mycompany.com`), then set your credentials.'
    );
  }
  const setupLabel = config.authType === 'cloud'
    ? 'Ticket Sidekick: Configure Jira Cloud Credentials'
    : 'Ticket Sidekick: Set Jira Personal Access Token';
  return `Jira credentials not configured. Run "${setupLabel}" from the Command Palette.`;
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

// ---------------------------------------------------------------------------------------------
// Template generation — the multi-turn flow that turns a reference ticket's template-shaped
// fields, or (with no reference) a project's required-fields create-metadata, into a reviewed,
// saved `.jira-templates.json` template. Reuses the shared renderReviewTable/parseReviewInput
// primitives above plus the `<row-id>=<value>` reply form for filling in a
// no-reference row's still-empty value inline, without a separate multi-turn detour. All
// `vscode`-coupled orchestration (streaming, workspaceState, calling TicketService/TemplateService)
// lives in `templateGenerationHandler.ts`; only pure session shapes/helpers live here so they stay
// Vitest-loadable.
// ---------------------------------------------------------------------------------------------

// Jira's required-fields create-metadata (the no-reference path's source, TicketService's
// getTemplateCandidatesFromRequiredFields) is not filtered by TicketService's template-shaped-field
// allowlist the way the reference-ticket path is — it returns every field the issue type's create screen
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
 * before the user fills it in via `<id>=<value>`). */
export interface TemplateFieldReviewRow {
  id: string;
  fieldId: string;
  name: string;
  value: unknown;
  included: boolean;
  schema?: TemplateFieldCandidate['schema'];
}

export function buildTemplateFieldReviewRows(candidates: TemplateFieldCandidate[]): TemplateFieldReviewRow[] {
  return candidates.map((c, i) => ({
    id: String(i + 1),
    fieldId: c.id,
    name: c.name,
    value: c.value,
    included: true,
    schema: c.schema,
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

/** Builds the literal `defaultFields` map (never `resolveFields`) from the reviewed rows.
 * Only included rows with a resolved value contribute; call findUnsetIncludedRows() first so an
 * included-but-still-unset row never reaches here silently. */
export function buildDefaultFieldsFromRows(rows: TemplateFieldReviewRow[]): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const row of rows) {
    if (!row.included || row.value === undefined) continue;
    // A value copied from a reference ticket already has its real Jira shape (object/array).
    // Only a hand-typed `<id>=<value>` reply is ever a bare string here, and that needs
    // coercing into a writable shape before it becomes a defaultFields entry — a raw string
    // where Jira expects e.g. `{ name }` (priority) or `string[]` (labels) gets rejected.
    fields[row.fieldId] = typeof row.value === 'string'
      ? coerceTypedFieldValue(row.value, row.schema)
      : row.value;
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

/** Parses a reply to the "pick an issue type" list (no-reference path, no type named) — by
 * number or by exact (case-insensitive) name. */
export function parseIssueTypePick(reply: string, issueTypes: string[]): string | 'cancel' | 'invalid' {
  if (isCancellation(reply)) return 'cancel';
  return pickByNumberOrName(reply, issueTypes) ?? 'invalid';
}

export type TemplateCollisionReply =
  | { action: 'cancel' }
  | { action: 'overwrite' }
  | { action: 'rename'; name: string }
  | { action: 'invalid' };

/** Parses the name-collision reply: cancel the whole flow, explicitly confirm overwriting the
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

/** Parses the "create a first ticket?" reply. A bare confirmation word ("yes") has no summary
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

/** Shared shape for the three later template-generation stages, which all carry only a template
 * plus project key — the stage (collision pending resolution, just-saved awaiting the
 * create-first-ticket offer, or awaiting a typed-in summary) is distinguished by which
 * workspaceState key/response tag holds the session, not by its shape. `template.name` on a
 * collision session is the attempted/colliding name; on the other two it's the already-saved name. */
export interface TemplateGenerationTemplateStageSession {
  template: JiraTemplate;
  projectKey: string;
  schemaVersion: number;
}
export type TemplateGenerationCollisionSession = TemplateGenerationTemplateStageSession;
export type TemplateGenerationOfferCreateSession = TemplateGenerationTemplateStageSession;
export type TemplateGenerationAwaitSummarySession = TemplateGenerationTemplateStageSession;

// ---------------------------------------------------------------------------------------------
// Language Model tools (Agent Mode) — pure confirmation-text and result-message builders shared
// by every `jira_*` tool in `src/tools/jiraTools.ts`. Kept here (rather than in jiraTools.ts,
// which imports `vscode` and is not Vitest-loadable) so this wording is unit-tested the same way
// every other user-facing message in this file is. `jiraTools.ts` stays thin glue: it resolves
// live data (current field values, project issue types, workflow graphs) via TicketService/
// WorkflowService/TemplateService and hands it to these functions to render.
// ---------------------------------------------------------------------------------------------

/** A tool's `prepareInvocation()` confirmation — `title`/`message` map directly onto
 * `vscode.LanguageModelToolConfirmationMessages`. */
export interface ToolConfirmation {
  title: string;
  message: string;
}

/** Renders a "current → new" change, e.g. `Critical → High` (KTD3). Shared by every builder
 * below that shows a before/after value. */
export function formatFieldChangeDisplay(currentValue: string, newValue: string): string {
  return `${currentValue} → ${newValue}`;
}

/** Confirmation for `jira_updateField` — always shows current → new (KTD3), even when the
 * current value could not be fetched (the caller passes a placeholder string in that case; the
 * confirmation still renders, it just can't show a real "before"). */
export function buildUpdateFieldConfirmation(
  ticketKey: string,
  fieldName: string,
  currentValue: string,
  newValue: string,
): ToolConfirmation {
  return {
    title: `Update ${fieldName} on ${ticketKey}`,
    message: `Set **${fieldName}** on **${ticketKey}**: ${formatFieldChangeDisplay(currentValue, newValue)}`,
  };
}

/** Confirmation for `jira_addComment` — names the ticket and shows the literal comment text. */
export function buildAddCommentConfirmation(ticketKey: string, comment: string): ToolConfirmation {
  return {
    title: `Add comment to ${ticketKey}`,
    message: `Post this comment on **${ticketKey}**:\n\n${comment}`,
  };
}

/** Confirmation for `jira_createTicket` — names project/type/summary (KTD4). `issueType` is
 * `null` when it hasn't been resolved yet at confirmation time (e.g. it depends on a template);
 * `invoke()` itself still enforces the never-guess fallback (KTD4) regardless of what this
 * confirmation showed. */
export function buildCreateTicketConfirmation(
  projectKey: string,
  issueType: string | null,
  summary: string,
  templateName: string | null,
): ToolConfirmation {
  const typeLabel = issueType ? `a **${issueType}**` : 'a ticket (issue type to be resolved)';
  const templateNote = templateName ? ` using template **${templateName}**` : '';
  return {
    title: `Create ticket in ${projectKey}`,
    message: `Create ${typeLabel} in **${projectKey}**${templateNote}: "${summary}"`,
  };
}

/** Confirmation for `jira_transitionTicket` — names the ticket and the target status.
 * `currentStatus` is `null` when it couldn't be fetched at confirmation time. */
export function buildTransitionConfirmation(
  ticketKey: string,
  currentStatus: string | null,
  targetStatus: string,
  resolution?: string,
): ToolConfirmation {
  const fromLabel = currentStatus ? `**${currentStatus}**` : 'its current status';
  const resNote = resolution ? ` (resolution: ${resolution})` : '';
  return {
    title: `Move ${ticketKey} to ${targetStatus}`,
    message: `Transition **${ticketKey}** from ${fromLabel} to **${targetStatus}**${resNote}.`,
  };
}

/** The never-guess fallback text for `jira_createTicket` (KTD4): when neither `issueType` nor a
 * resolvable `templateName` was given, nothing is created and this lists the project's valid
 * issue types (from `TicketService.getIssueTypes`) as the actionable next step — mirrors the
 * chat create flow's own never-guess sentinel handling
 * (docs/solutions/logic-errors/combined-create-list-silently-guesses-issue-type-and-drops-no-template-fallback.md)
 * adapted from a `showInputBox` prompt to a returned list, since Agent Mode has no interactive
 * input box to fall back to. */
export function formatIssueTypeOptionsMessage(projectKey: string, issueTypes: string[]): string {
  if (issueTypes.length === 0) {
    return (
      `No ticket was created: no issue type or resolvable template was given for project ${projectKey}, ` +
      `and its issue types could not be fetched from Jira. Call jira_createTicket again with an explicit "issueType".`
    );
  }
  const list = issueTypes.map(t => `- ${t}`).join('\n');
  return (
    `No ticket was created: no issue type or resolvable template was given. Valid issue types for **${projectKey}**:\n\n${list}\n\n` +
    `Call jira_createTicket again with one of these as "issueType", or with a "templateName" from jira_listTemplates.`
  );
}

/** Result text for `jira_listTemplates` — a missing/empty `.jira-templates.json` is a normal,
 * error-free outcome (an empty list), not a failure. */
export function formatTemplateListMessage(templates: Array<{ name: string; issueType?: string }>): string {
  if (templates.length === 0) {
    return 'No templates found. Create a `.jira-templates.json` file in the workspace root to define reusable ticket templates.';
  }
  const list = templates
    .map(t => `- **${t.name}**${t.issueType ? ` (${t.issueType})` : ' (issue type not set on the template)'}`)
    .join('\n');
  return `Available templates:\n\n${list}`;
}

// ---------------------------------------------------------------------------------------------
// Follow-up suggestion chips + greeting/empty-prompt detection (onboarding, U5) — pure logic so
// it stays Vitest-covered (KTD15). The vscode-coupled `participant.followupProvider` wiring and
// the pre-`parseIntent` greeting/empty check live in `JiraParticipant.ts`; both consume the
// exports below rather than re-deriving this logic.
// ---------------------------------------------------------------------------------------------

/** A `vscode.ChatFollowup`-shaped suggestion, without the `vscode` dependency — the participant
 * maps this 1:1 onto a real `vscode.ChatFollowup` in its `followupProvider`. */
export interface FollowupSuggestion {
  prompt: string;
  label?: string;
}

/**
 * Exact-match (not substring/word-list) detection of an empty invocation or an obvious
 * greeting/help-shaped prompt — mirrors `isConfirmation()`/`isCancellation()`'s own
 * whole-normalized-string `Set` membership above, for the same reason: a substring or
 * per-word test on "hi" would misfire on legitimate operation text like "update HI-1
 * status", but an exact-string `Set` membership check never can, since the normalized whole
 * prompt "update hi-1 status" is never equal to "hi". See the specific-before-generic ordering
 * principle in
 * docs/solutions/logic-errors/confirm-cancel-word-list-broadening-swallows-domain-name-collisions.md
 * — this function sidesteps that hazard entirely by never doing substring matching in the first
 * place, rather than needing a live-domain-value check ordered ahead of it.
 */
const GREETING_OR_HELP_PHRASES = new Set<string>([
  '', 'hi', 'hello', 'hey', 'hiya', 'yo', 'howdy',
  'help', 'help me', '?', "what's up", 'whats up',
  'what can you do', 'what do you do', 'what can you help with', 'what can you help me with',
  'how does this work', 'how do i use this', 'how do i use you',
  'getting started', 'get started', 'what is this', 'who are you',
]);

export function isGreetingOrEmpty(prompt: string): boolean {
  const normalized = prompt.trim().toLowerCase().replace(/[!?.]+$/g, '').replace(/\s+/g, ' ').trim();
  return GREETING_OR_HELP_PHRASES.has(normalized);
}

/** Discriminated "what just happened" shape `JiraParticipant.ts` round-trips through
 * `vscode.ChatResult.metadata` so its `followupProvider` can compute the right suggestion chips
 * for the response that was just streamed, without re-deriving state from response text. */
export type JiraFollowupState =
  | { kind: 'greeting' }
  | { kind: 'fallback' }
  | { kind: 'loadedTicket'; ticketKey: string }
  | { kind: 'none' };

const JIRA_MAX_FOLLOWUPS = 3;

/**
 * R6/KTD14: 2-3 example prompts, phrased as literal next messages a user could send, for a
 * major `@jira` response — including R8's unclassifiable-prompt fallback and R9's
 * greeting/empty-prompt response, which deliver their examples ONLY as these chips rather than
 * as separate inline prose guidance.
 */
export function computeJiraFollowups(state: JiraFollowupState): FollowupSuggestion[] {
  switch (state.kind) {
    case 'greeting':
      return [
        { prompt: 'create a ticket', label: 'Create a ticket' },
        { prompt: 'show me PROJ-123', label: 'View a ticket' },
        { prompt: 'search my open tickets', label: 'Search tickets' },
      ].slice(0, JIRA_MAX_FOLLOWUPS);
    case 'fallback':
      return [
        { prompt: 'show me PROJ-123', label: 'View a ticket' },
        { prompt: 'add a comment to PROJ-123', label: 'Add a comment' },
        { prompt: 'search my open tickets', label: 'Search tickets' },
      ].slice(0, JIRA_MAX_FOLLOWUPS);
    case 'loadedTicket':
      return [
        { prompt: `add a comment to ${state.ticketKey}`, label: 'Add a comment' },
        { prompt: `transition ${state.ticketKey}`, label: 'Transition it' },
      ];
    case 'none':
      return [];
  }
}

/** Result text for `jira_discoverWorkflow` — mirrors `handleDiscoverWorkflow`'s chat summary
 * (`src/participant/jira/workflowHandler.ts`) in plain returned text rather than a streamed
 * response, since a tool result is a single returned string, not a live chat stream. */
export function formatWorkflowDiscoveryMessage(
  projectKey: string,
  issueType: string,
  graph: WorkflowGraph,
  skippedStatuses: string[],
  preserved: string[],
): string {
  const statuses = Object.keys(graph);
  if (statuses.length === 0) {
    return `No tickets found for ${projectKey} / ${issueType} — workflow could not be sampled.`;
  }
  const lines = statuses.map((s) => {
    const targets = graph[s].map((t) => `${t.name} → ${t.to}`).join(', ');
    return `**${s}**: ${targets}`;
  });
  let summary = `Workflow discovered for **${projectKey} / ${issueType}** (${lines.length} statuses):\n\n${lines.join('\n\n')}\n\nSaved to \`.jira-workflow-cache.json\`.`;
  const trulySkipped = skippedStatuses.filter(s => !preserved.includes(s));
  if (preserved.length > 0) {
    summary += `\n\n_${preserved.length} status(es) had no tickets and kept cached transitions: ${preserved.join(', ')}._`;
  }
  if (trulySkipped.length > 0) {
    summary += `\n\n_${trulySkipped.length} status(es) had no tickets and no cached transitions: ${trulySkipped.join(', ')} — re-run jira_discoverWorkflow once tickets exist in those states._`;
  }
  return summary;
}

