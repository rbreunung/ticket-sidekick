import type { JiraComment, JiraFieldMeta, JiraFilter, JiraSprintCandidate } from '../jira/IJiraClient';
import { formatJiraBody } from '../utils/markdownFormatter';
import type { VeracodeFlaw, VeracodeReviewRow } from '../utils/veracodeReport';
import type { WaltzComponent, WaltzReviewRow } from '../utils/waltzReport';
import { BATCH_LIMIT } from '../utils/reportImport';
import { formatKeyLink } from '../services/TicketService';

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

export interface TemplateSelectionSession {
  templateNames: string[];
  originalPrompt: string;
}

export interface IssueTypeSelectionSession {
  issueTypes: string[];
  project: string;
  summary: string | null;
  templateName: string | null;
  description: string | null;
  extraFields?: Record<string, unknown>;
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

export function buildReviewTable(session: TransitionBatchSession): string {
  const hasResolution = session.resolution !== undefined;
  const header = hasResolution
    ? '| Type | Key | Summary | From | → To | Resolution |\n|------|-----|---------|------|------|------------|\n'
    : '| Type | Key | Summary | From | → To |\n|------|-----|---------|------|------|\n';

  const sorted = [...session.tickets].sort((a, b) =>
    a.currentStatus.toLowerCase().localeCompare(b.currentStatus.toLowerCase()),
  );

  const rows: string[] = [];
  for (const t of sorted) {
    const tTo = t.transitionPath.at(-1)?.to ?? '?';
    const tRes = hasResolution ? ` | ${session.resolution ?? ''}` : '';
    rows.push(`| ${session.issueType} | ${t.key} | ${t.summary} | ${t.currentStatus} | ${tTo}${tRes} |`);
    for (const s of t.subtasks) {
      const sTo = s.transitionPath.at(-1)?.to ?? '?';
      const sRes = hasResolution ? ` | ${s.resolution ?? session.resolution ?? ''}` : '';
      rows.push(`| Sub-task | ↳ ${s.key} | ${s.summary} | ${s.currentStatus} | ${sTo}${sRes} |`);
    }
  }

  return header + rows.join('\n') + '\n\npost it · (c) · key numbers to skip (e.g. 11 14)';
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

export function parseIssueTypeSelection(reply: string, types: string[]): string | 'cancel' | 'invalid' {
  const normalized = reply.trim().toLowerCase();
  // A real issue type name wins over the generic cancellation word list — otherwise a
  // project with a type literally named "Stop" or "Quit" could never select it by name.
  const match = types.find((t) => t.toLowerCase() === normalized);
  if (match) return match;
  if (isCancellation(reply)) return 'cancel';
  const num = parseInt(normalized, 10);
  if (!isNaN(num) && num >= 1 && num <= types.length) return types[num - 1];
  return 'invalid';
}

export function parseTemplateSelection(reply: string, templateNames: string[]): string | null | 'cancel' | 'invalid' {
  const normalized = reply.trim().toLowerCase();
  // A real template name wins over the generic cancellation word list, for the same reason
  // as parseIssueTypeSelection above.
  const match = templateNames.find((name) => name.toLowerCase() === normalized);
  if (match) return match;
  if (isCancellation(reply)) return 'cancel';
  // `skip` and `no` are deliberately absent here — both now mean cancel (via isCancellation
  // above), not "proceed without a template". Use one of these instead.
  const NO_TEMPLATE = new Set(['n', 'no template', 'none', '0', 'without template']);
  if (NO_TEMPLATE.has(normalized)) return null;
  const num = parseInt(normalized, 10);
  if (!isNaN(num) && num >= 1 && num <= templateNames.length) return templateNames[num - 1];
  return 'invalid';
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
  // A real filter name wins over the generic cancellation word list, for the same reason
  // as parseIssueTypeSelection above.
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
  const headerCells = columns.map(c => c.header).join(' | ');
  const sepCells = columns.map(() => '----------').join('|');
  const pluralBare = itemNoun.replace('(s)', 's'); // 'component(s)' -> 'components'

  if (ticketed.length > 0) {
    lines.push('### Already ticketed');
    lines.push(`| # | ${headerCells} | Ticket | Include? |`);
    lines.push(`|---|${sepCells}|--------|----------|`);
    for (const r of ticketed) {
      const ticketRef = formatKeyLink(r.existingTicketKey!, baseUrl);
      const cells = columns.map(c => c.accessor(r)).join(' | ');
      lines.push(`| ${r.id} | ${cells} | ${ticketRef} | ${r.included ? '✓ re-create' : '_excluded_'} |`);
    }
    lines.push('');
  }

  lines.push('### New — will create');
  if (fresh.length === 0) {
    lines.push(`_All matching ${pluralBare} already have a ticket._`);
  } else {
    lines.push(`| # | ${headerCells} | Include? |`);
    lines.push(`|---|${sepCells}|----------|`);
    for (const r of fresh) {
      const cells = columns.map(c => c.accessor(r)).join(' | ');
      lines.push(`| ${r.id} | ${cells} | ${r.included ? '✓' : '_excluded_'} |`);
    }
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

export type ReviewParseResult =
  | { action: 'ok' }
  | { action: 'cancel' }
  | { action: 'toggle'; ids: string[] }
  | { action: 'invalid' };

export function parseReviewInput(reply: string, rowIds: string[]): ReviewParseResult {
  const normalized = reply.trim().toLowerCase();
  if (isConfirmation(reply)) return { action: 'ok' };
  if (isCancellation(reply)) return { action: 'cancel' };

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

