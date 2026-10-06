// Creation, content, comment, transition-batch and resolution-selection sessions, plus the transition review table and skip-input parsing.
// Pure (vscode-free); re-exported through ../sessionState.ts.

import type { JiraFieldMeta } from '../../jira/IJiraClient';
import { formatKeyLink, buildExtraFieldColumns } from '../../services/TicketService';
import { ReviewTableColumn, buildChatCommandLink, isCancellation, isConfirmation, neutralizeMarkdownLinks, pickByNumberOrName, renderReviewTable } from './primitives';
import { TransitionBatchTicket } from './sessionTypes';

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

export interface CreateSelectionSession {
  templates: Array<{ name: string; issueType: string }>;
  issueTypes: string[];
  projectKey: string;
  summary: string | null;
  description: string | null;
  extraFields?: Record<string, unknown>;
  originalPrompt: string;
}

export interface TransitionBatchSession {
  tickets: TransitionBatchTicket[];
  resolution: string | undefined;
  ruleName: string | undefined;
  issueType: string;
  fieldIds: string[];
  fieldMeta: JiraFieldMeta[];
}

interface TransitionReviewRow {
  type: string;
  key: string;
  summary: string;
  currentStatus: string;
  to: string;
  resolution: string;
  extra?: Record<string, unknown>;
  included: boolean;
  // The row's own toggle reply text (R8). The FULL key, not just its numeric suffix — a batch can
  // span multiple projects (an arbitrary JQL search), where two tickets can share a numeric suffix
  // (e.g. ABC-11 and XYZ-11); parseSkipInput() resolves a full key unambiguously, whereas a bare
  // suffix is only honored when it isn't ambiguous in the batch (code-review fix).
  rawKey: string;
}

/**
 * Renders the cleanup/bulk-transition review table. `onUnknownField`, when given, is forwarded to
 * `buildExtraFieldColumns` (KTD5) so a caller that imports `vscode` can log a warning for a
 * `cleanupFields` ID with no matching field metadata — this function itself stays vscode-free.
 */
export function buildReviewTable(
  session: TransitionBatchSession,
  baseUrl?: string,
  onUnknownField?: (fieldId: string) => void,
): string {
  const hasResolution = session.resolution !== undefined;

  const sorted = [...session.tickets].sort((a, b) =>
    a.currentStatus.toLowerCase().localeCompare(b.currentStatus.toLowerCase()),
  );

  // Ticket summaries are untrusted, externally-influenced content — this table's footer is a
  // trusted MarkdownString (KTD5), so neutralizeMarkdownLinks() keeps a crafted summary from
  // forming a live command link once the whole thing is trust-gated (see its own doc comment).
  const flatRows: TransitionReviewRow[] = [];
  for (const t of sorted) {
    flatRows.push({
      type: session.issueType,
      key: formatKeyLink(t.key, baseUrl),
      summary: neutralizeMarkdownLinks(t.summary),
      currentStatus: t.currentStatus,
      to: t.transitionPath.at(-1)?.to ?? '?',
      resolution: session.resolution ?? '',
      extra: t.extra,
      included: t.included,
      rawKey: t.key,
    });
    for (const s of t.subtasks) {
      flatRows.push({
        type: 'Sub-task',
        key: `↳ ${formatKeyLink(s.key, baseUrl)}`,
        summary: neutralizeMarkdownLinks(s.summary),
        currentStatus: s.currentStatus,
        to: s.transitionPath.at(-1)?.to ?? '?',
        resolution: s.resolution ?? session.resolution ?? '',
        extra: s.extra,
        included: s.included,
        rawKey: s.key,
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
    ...buildExtraFieldColumns<TransitionReviewRow>(
      session.fieldIds ?? [],
      session.fieldMeta ?? [],
      (row, id) => row.extra?.[id],
      onUnknownField,
    ),
    // R8/R9: positive "will transition when checked" framing — clicking resubmits this row's own
    // numeric suffix, the exact text the existing typed "11 14" toggle syntax already accepts
    // (parseSkipInput), so no new parser logic (Risks section).
    { header: 'Transition?', accessor: (r) => buildChatCommandLink(r.included ? '✓' : '_excluded_', '@jira', r.rawKey) },
  ];

  return renderReviewTable(columns, flatRows) + '\n\n' +
    `${buildChatCommandLink('post it', '@jira', 'post it')} · ${buildChatCommandLink('(c)', '@jira', 'cancel')} · key numbers to toggle (e.g. 11 14)`;
}

export interface ResolutionSelectionSession {
  tickets: TransitionBatchTicket[];
  ruleName: string | undefined;
  issueType: string;
  targetState: string;
  resolutionOptions: string[];
  fieldIds: string[];
  fieldMeta: JiraFieldMeta[];
}

// U6: 'skip' was renamed 'toggle' — a mentioned ticket's (and its cascaded parent/subtask's)
// `included` flag flips and the table re-renders (R8/AE4), rather than the reply immediately
// executing the batch with those tickets excluded. 'ok' (e.g. "post it") is now the only action
// that actually runs the batch, using each ticket/subtask's current `included` flag.
export type SkipParseResult =
  | { action: 'ok' }
  | { action: 'cancel' }
  | { action: 'toggle'; keys: string[] }
  | { action: 'invalid' };

// The remaining fields (once template/issue-type selection and ticket creation moved to
// EmailTemplateSelectionSession/EmailReviewSession — see KTD1 in reportImportHandler.ts) are exactly
// what the single-file "add email as a comment" flow needs.
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
  pendingCommentTicketKey?: string;
}

export function parseSkipInput(reply: string, tickets: TransitionBatchTicket[]): SkipParseResult {
  const normalized = reply.trim().toLowerCase();
  if (isConfirmation(reply)) return { action: 'ok' };
  if (isCancellation(reply)) return { action: 'cancel' };

  const parts = normalized.split(/\s+/).filter(Boolean);
  // Code-review fix: a batch can span multiple projects (an arbitrary JQL search, not
  // project-scoped), so two tickets can share the same numeric suffix (e.g. ABC-11 and XYZ-11).
  // buildReviewTable()'s per-row toggle link resubmits the row's own full key (unambiguous,
  // matched via byFullKey below); the typed "11 14" shorthand still resolves by numeric suffix
  // (bySuffix) but ONLY when that suffix is unambiguous in this batch — an ambiguous suffix is
  // never guessed at, since silently toggling the wrong ticket is worse than treating it as
  // unmatched.
  const byFullKey = new Map<string, string>(); // lowercased full key → full key
  const bySuffix = new Map<string, string>(); // numeric suffix → full key (only when unambiguous)
  const ambiguousSuffixes = new Set<string>();
  const registerKey = (key: string) => {
    byFullKey.set(key.toLowerCase(), key);
    const suffix = key.split('-')[1];
    if (!suffix) return;
    if (bySuffix.has(suffix) && bySuffix.get(suffix) !== key) {
      ambiguousSuffixes.add(suffix);
    } else {
      bySuffix.set(suffix, key);
    }
  };
  for (const t of tickets) {
    registerKey(t.key);
    for (const s of t.subtasks) registerKey(s.key);
  }

  const mentioned = new Set<string>();
  for (const p of parts) {
    const fullKeyMatch = byFullKey.get(p);
    if (fullKeyMatch) {
      mentioned.add(fullKeyMatch);
      continue;
    }
    if (!ambiguousSuffixes.has(p)) {
      const suffixMatch = bySuffix.get(p);
      if (suffixMatch) mentioned.add(suffixMatch);
    }
  }
  if (mentioned.size === 0) return { action: 'invalid' };

  // Cascade: subtask mentioned → also toggle parent; parent mentioned → also toggle all subtasks —
  // unchanged from the pre-U6 one-shot skip cascade, just applied as a flip now instead of a final
  // exclude set (see applyTicketToggle below).
  const expanded = new Set(mentioned);
  for (const t of tickets) {
    if (mentioned.has(t.key)) {
      for (const s of t.subtasks) expanded.add(s.key);
    }
    for (const s of t.subtasks) {
      if (mentioned.has(s.key)) expanded.add(t.key);
    }
  }
  return { action: 'toggle', keys: [...expanded] };
}

// U6/AE4: flips `included` for every ticket/subtask whose key is in `keys` (the cascaded set
// parseSkipInput already computed) — pure so it's independently testable, mirroring
// applyReviewToggle's shape for the import-review tables. The caller re-renders via
// buildReviewTable() afterward; this never executes anything itself.
export function applyTicketToggle(tickets: TransitionBatchTicket[], keys: string[]): TransitionBatchTicket[] {
  const toggleSet = new Set(keys);
  return tickets.map(t => ({
    ...t,
    included: toggleSet.has(t.key) ? !t.included : t.included,
    subtasks: t.subtasks.map(s => (toggleSet.has(s.key) ? { ...s, included: !s.included } : s)),
  }));
}

export function parseResolutionSelection(reply: string, options: string[]): string | null | 'invalid' {
  const normalized = reply.trim().toLowerCase();
  if (normalized === 'none' || normalized === 'skip') return null;
  return pickByNumberOrName(reply, options, (s) => s) ?? 'invalid';
}
