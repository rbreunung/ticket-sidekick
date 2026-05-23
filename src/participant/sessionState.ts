import type { JiraComment, JiraFieldMeta, JiraFilter, JiraSprintCandidate } from '../jira/IJiraClient';
import { formatJiraBody } from '../utils/markdownFormatter';

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

export interface ContentSession {
  ticketKey: string;
  operation: 'addComment' | 'updateDescription';
  currentContent: string;
  historyContext: string | undefined;
}

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
}

export interface ResolutionSelectionSession {
  tickets: TransitionBatchTicket[];
  ruleName: string | undefined;
  targetState: string;
  resolutionOptions: string[];
}

export type SkipParseResult =
  | { action: 'ok' }
  | { action: 'cancel' }
  | { action: 'skip'; keys: string[] }
  | { action: 'invalid' };

// --- Outlook email-to-ticket sessions ---

export interface HandoverEmail {
  subject: string;
  senderName: string;
  receivedDateTime: string;
  markdownBody: string;
  stripFooter: boolean;
  handoverFolder: string;
  timestamp: string;
  attachments: Array<{
    name: string;
    contentType: string;
    dataBase64: string;
    isInline: boolean;
  }>;
}

export interface FolderSelectionSession {
  folders: Array<{ id: string; displayName: string; unreadItemCount: number }>;
}

export interface EmailSelectionSession {
  folderId: string;
  emails: Array<{ id: string; subject: string; receivedDateTime: string; senderName: string }>;
}

export interface EmailContentSession {
  emailId: string;
  subject: string;
  markdownBody: string;
  inlineImageMap: Record<string, string>;
  attachments: Array<{
    name: string; contentType: string; contentBytes: string;
    isInline: boolean; contentId?: string;
  }>;
  selectedTemplateName: string | null;
  projectKey: string;
  issueType: string;
  additionalFields: Record<string, unknown>;
  handoverCleanup?: { folder: string; timestamp: string };
}

export function parseSkipInput(reply: string, tickets: TransitionBatchTicket[]): SkipParseResult {
  const normalized = reply.trim().toLowerCase();
  if (normalized === 'ok') return { action: 'ok' };
  if (normalized === 'c' || normalized === 'cancel') return { action: 'cancel' };

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
  if (normalized === 'c' || normalized === 'cancel') return 'cancel';
  const num = parseInt(normalized, 10);
  if (!isNaN(num) && num >= 1 && num <= types.length) return types[num - 1];
  if (!isNaN(num)) return 'invalid';
  const match = types.find((t) => t.toLowerCase() === normalized);
  return match ?? 'invalid';
}

export function parseTemplateSelection(reply: string, templateNames: string[]): string | null | 'cancel' | 'invalid' {
  const normalized = reply.trim().toLowerCase();
  if (normalized === 'c' || normalized === 'cancel') return 'cancel';
  const NO_TEMPLATE = new Set(['n', 'no template', 'none', 'skip', '0', 'no', 'without template']);
  if (NO_TEMPLATE.has(normalized)) return null;
  const num = parseInt(normalized, 10);
  if (!isNaN(num) && num >= 1 && num <= templateNames.length) return templateNames[num - 1];
  const match = templateNames.find((name) => name.toLowerCase() === normalized);
  return match ?? 'invalid';
}

export function extractLastTicketFromText(text: string): string | null {
  const match = text.match(/<!--\s*@jira-ticket:([A-Z][A-Z0-9]+-\d+)\s*-->/);
  return match ? match[1] : null;
}

export function stripHiddenMarkers(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, '').replace(/\s+/g, ' ').trim();
}

export function serializeTurns(
  turns: Array<{ role: 'user' | 'assistant'; text: string }>,
  mode: 'recent' | 'full',
): string {
  const selected = mode === 'recent' ? turns.slice(-3) : turns;
  return selected
    .filter((t) => t.text.length > 0)
    .map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.text}`)
    .join('\n\n');
}

export function extractCreatedKeyFromConfirmation(confirmation: string): string | null {
  const m = confirmation.match(/([A-Z][A-Z0-9]+-\d+)/);
  return m ? m[1] : null;
}

export function isConfirmation(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  const CONFIRMATIONS = new Set([
    'yes', 'yep', 'ok', 'okay', 'sure', 'perfect', 'great',
    'looks good', 'looks great', 'go ahead', 'do it', 'ship it',
    'post it', 'confirm', 'confirmed', 'submit', 'approved', 'approve', 'fine',
    'load all', 'load more', 'show all', 'show more',
  ]);
  return CONFIRMATIONS.has(normalized);
}

export function isCancellation(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  const CANCELLATIONS = new Set([
    'no', 'nope', 'cancel', 'cancelled', 'stop', 'abort',
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
  if (/^(c|cancel)$/i.test(trimmed)) return { action: 'cancel' };
  if (/^(ok|yes|confirm)$/i.test(trimmed)) return { action: 'ok', skip: [] };
  const skipMatch = trimmed.match(/^skip\s+(.*)/i);
  if (skipMatch) {
    const keys = skipMatch[1].trim().split(/[\s,]+/).filter(Boolean);
    return { action: 'ok', skip: keys };
  }
  return { action: 'invalid' };
}

export function parseFilterSelection(reply: string, filters: JiraFilter[]): JiraFilter | 'cancel' | 'invalid' {
  const trimmed = reply.trim();
  if (/^(c|cancel)$/i.test(trimmed)) return 'cancel';
  const byIndex = trimmed.match(/^(\d+)$/);
  if (byIndex) {
    const n = parseInt(byIndex[1], 10);
    if (n >= 1 && n <= filters.length) return filters[n - 1];
    return 'invalid';
  }
  const byName = filters.find(f => f.name.toLowerCase() === trimmed.toLowerCase());
  if (byName) return byName;
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

export function parseSkippedAttachmentSelection(reply: string, count: number): number | 'invalid' {
  const n = parseInt(reply.trim(), 10);
  if (!isNaN(n) && n >= 1 && n <= count) return n;
  return 'invalid';
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

