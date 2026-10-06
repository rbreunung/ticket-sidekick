// Leaf helpers shared by every session module: chat command links, markdown neutralizing, confirm/cancel words, pick-by-number, review-table renderer.
// Pure (vscode-free); re-exported through ../sessionState.ts.

import { TICKET_ID_PATTERN } from '../../utils/branchParser';

// Shared by parseResolutionSelection and parseIssueTypePick: resolves a reply to one list item
// by 1-based number or by exact case-insensitive name (matched via `nameOf`). The
// `String(n) === trimmed` guard rejects a partially-numeric string like "1abc" rather than letting
// parseInt silently truncate it into a match. Returns undefined when neither form matches. Generic
// over `T` so callers can pass either a plain `string[]` (nameOf: (s) => s) or a richer option
// shape like `{id, name}[]` (nameOf: (t) => t.name) and get the matched entry itself back.
export function pickByNumberOrName<T>(reply: string, options: T[], nameOf: (t: T) => string): T | undefined {
  const trimmed = reply.trim();
  const n = parseInt(trimmed, 10);
  if (!isNaN(n) && String(n) === trimmed && n >= 1 && n <= options.length) return options[n - 1];
  return options.find(o => nameOf(o).toLowerCase() === trimmed.toLowerCase());
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

/** `back` or any isCancellation() word — the stale close's "return to the Stale screen" reply.
 * isCancellation() itself leaves out `back`, which other flows use as a navigation command. */
export function isBackOrCancellation(text: string): boolean {
  return text.trim().toLowerCase() === 'back' || isCancellation(text);
}

// Code-review fix: derived from branchParser.ts's own TICKET_ID_PATTERN (one source of truth for
// the Jira ticket-key shape) rather than a second, independently-typed copy — anchored for a
// full-token match and case-insensitive, since this validates a typed/click-generated toggle
// token, not an arbitrary branch name.
export const TICKET_KEY_TOKEN = new RegExp(`^${TICKET_ID_PATTERN.source}$`, 'i');

/**
 * Builds a raw `[label](command:workbench.action.chat.open?<encoded>)` markdown link that,
 * when clicked, re-submits `replyText` to this participant exactly as if the user had typed it
 * (R5) — reusing VS Code's built-in `workbench.action.chat.open` command rather than a new
 * registered wrapper command (KTD2).
 *
 * `label` is neutralized (see `neutralizeMarkdownLinks()` below) before being embedded: a label
 * built from externally-influenced text (a Jira filter/template name, a ticket subject, …) that
 * contains an unneutralized `]` would close the `[label]` early, letting the rest of that text open
 * a second, attacker-chosen `(command:...)` link of its own right next to this legitimate one —
 * not merely garbled rendering, but a second live command. Callers therefore never need to
 * pre-sanitize a label themselves.
 *
 * Pure string building only — this never touches `vscode.MarkdownString` (KTD5). Every call site
 * that assembles a `MarkdownString` from output containing one or more of these links MUST set
 * `.isTrusted = { enabledCommands: ['workbench.action.chat.open'] }` on that `MarkdownString`
 * before calling `stream.markdown(...)`, mirroring the existing `settingsLink`/`credentialsLink`
 * trust-gate pattern in `JiraParticipant.ts` (and `notConfigured` in `BitbucketParticipant.ts`).
 * Without that, VS Code renders the link as inert plain text instead of a clickable command.
 */
export function buildChatCommandLink(label: string, participantId: '@jira' | '@bitbucket', replyText: string): string {
  const safeLabel = neutralizeMarkdownLinks(label);
  const query = `${participantId} ${replyText}`;
  const encodedArgs = encodeURIComponent(JSON.stringify({ query, isPartialQuery: false }));
  return `[${safeLabel}](command:workbench.action.chat.open?${encodedArgs})`;
}

/**
 * `buildChatCommandLink()`'s counterpart on the untrusted side: neutralizes markdown link/image
 * syntax in untrusted, externally-influenced text (a Jira ticket summary, custom field value, an
 * imported item's subject/title, …) before it is combined into the same string as one or more
 * real command links and the whole thing is trust-gated (`trustedChatMarkdown()`,
 * `src/utils/chatMarkdown.ts`). Without this, a crafted `[label](command:workbench.action.chat.open?…)`
 * sequence hiding inside that untrusted text would render as a live, clickable command once the
 * response is trusted — silently resubmitting an attacker-chosen message as the user's own next
 * chat turn. Replaces `[`/`]` with visually similar full-width brackets rather than stripping them,
 * so the text stays readable and no other markdown-significant character is touched — unlike
 * `sanitizeCellText()` (`reportImport.ts`), which also strips wiki-markup trigger characters for a
 * different destination (Jira wiki markup, not this extension's own trusted chat responses).
 */
export function neutralizeMarkdownLinks(value: string): string {
  return value.replace(/\[/g, '［').replace(/\]/g, '］');
}

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

export function pluralNoun(itemNoun: string): string {
  return itemNoun.replace('(s)', 's'); // 'component(s)' -> 'components'
}

export function countedNoun(count: number, itemNoun: string): string {
  return `${count} ${count === 1 ? itemNoun.replace('(s)', '') : pluralNoun(itemNoun)}`;
}

export function cmdLink(label: string, command: string): string {
  return buildChatCommandLink(label, '@jira', command);
}

/** Makes untrusted text safe inside one trusted markdown table cell: no links, no cell breaks. */
export function safeCellText(value: string): string {
  return neutralizeMarkdownLinks(value).replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
}

export function normalizeReply(reply: string): string {
  return reply.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Renders `items` as a `- ` bulleted list, one per line — shared by every result message
 * below that lists plain strings or pre-formatted per-item text. Exported so `jiraTools.ts`'s
 * ambiguous-match text results use the same shape instead of a second hand-rolled join. */
export function formatBulletList(items: string[]): string {
  return items.map(item => `- ${item}`).join('\n');
}
