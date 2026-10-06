// Report-import per-screen reply parsing, merge/unmerge/add helpers, reply vocabulary and done summary.
// Pure (vscode-free); re-exported through ../sessionState.ts.

import { TICKETED_ACTION_ORDER } from '../../utils/reportImport';
import { formatKeyLink } from '../../services/TicketService';
import { IMPORT_COMMANDS, LEGACY_UPDATE_COMMAND } from './importScreens';
import { AddMode, ImportOutcomes, ImportResultGroup, ImportReviewView, ReviewRowBase, ReviewSessionStale, TicketedAction } from './importTypes';
import { cmdLink, isCancellation, isConfirmation, neutralizeMarkdownLinks, normalizeReply } from './primitives';
import { ReviewPageNav, parseBulkNewRowReply, parseReviewPageNav } from './reviewPaging';
import { parseStaleTicketToggle } from './staleTargets';

/** What a reply on the current import screen asks for (KTD2). */
export type ImportReplyAction =
  | { kind: 'open'; view: ImportResultGroup }
  | { kind: 'done' }
  | { kind: 'back' }
  | { kind: 'create' }
  | { kind: 'update' } // U4/R10: run only the rows set to `update`
  | { kind: 'recreate' } // U4/R10: run only the rows set to `re-create`
  | { kind: 'apply' } // U4/R9: run every unfinished row not on `leave`
  | { kind: 'setAction'; id: string; action: TicketedAction }
  | { kind: 'setAllActions'; action: TicketedAction }
  | { kind: 'close' }
  | { kind: 'pageNav'; nav: ReviewPageNav }
  | { kind: 'bulk'; include: boolean }
  | { kind: 'merge'; ids: string[] } // finding folding: combine these visible New rows into one
  | { kind: 'unmerge'; id: string } // finding folding: split a merged row back into its originals
  // Finding folding: add rows to an existing ticket. `addPrompt` (no mode yet) shows the ticket and
  // the Comment / Rewrite choice; `add` carries the chosen mode and executes.
  | { kind: 'addPrompt'; ids: string[]; key: string }
  | { kind: 'add'; ids: string[]; key: string; mode: AddMode }
  // Accepted-CVE list: hide the CVEs of these visible New rows from future imports (with an optional
  // reason), list the entries, or remove the entry at that 1-based position.
  | { kind: 'accept'; ids: string[]; reason?: string }
  | { kind: 'listAccepted' }
  | { kind: 'unaccept'; position: number }
  | { kind: 'toggleRows'; ids: string[] }
  | { kind: 'toggleStale'; keys: string[] }
  // `reason`, when present, says specifically why (e.g. an action a row does not offer, AE6).
  | { kind: 'invalid'; reason?: string };

export interface ImportReplyContext {
  singleGroup: boolean;
  groups: ImportResultGroup[];
  newRowIds: string[]; // ids of the new rows on the visible page
  // U4: the already-ticketed rows whose action has not run yet, with the actions each offers —
  // a finished row is absent, so it can no longer be changed.
  ticketedRows: Array<{ id: string; allowedActions: TicketedAction[] }>;
  stale?: ReviewSessionStale;
  // Finding folding: whether the importer supports merge/unmerge at all (Veracode and Waltz; not
  // email), and which visible New rows are merged rows (the only valid `unmerge` targets).
  canFold?: boolean;
  mergedRowIds?: string[];
  // Accepted-CVE list: whether the importer supports it (Waltz), which turns on `accept`, `accepted`
  // and `unaccept`.
  canAccept?: boolean;
}

/** Every token must be one of `ids` (case-insensitive) — a stray token makes the reply invalid
 * rather than half-applied, so a token from another screen's vocabulary is never acted on (R6). */
function parseStrictRowToggle(reply: string, ids: string[]): string[] | null {
  const tokens = reply.trim().split(/[\s,]+/).filter(Boolean);
  if (tokens.length === 0) return null;
  const byLower = new Map(ids.map(id => [id.toLowerCase(), id]));
  const matched: string[] = [];
  for (const token of tokens) {
    const found = byLower.get(token.toLowerCase());
    if (!found) return null;
    matched.push(found);
  }
  return matched;
}

export function parseOverviewReply(reply: string, ctx: ImportReplyContext): ImportReplyAction {
  const n = normalizeReply(reply);
  if (n === IMPORT_COMMANDS.done || isCancellation(reply)) return { kind: 'done' };
  if (n === IMPORT_COMMANDS.openNew && ctx.groups.includes('new')) return { kind: 'open', view: 'new' };
  if (n === IMPORT_COMMANDS.openTicketed && ctx.groups.includes('ticketed')) return { kind: 'open', view: 'ticketed' };
  if (n === IMPORT_COMMANDS.openStale && ctx.groups.includes('stale')) return { kind: 'open', view: 'stale' };
  const listing = ctx.canAccept ? parseAcceptedListReply(reply) : null;
  if (listing) return listing;
  return { kind: 'invalid' };
}

const UNACCEPT_USAGE = 'Remove an accepted entry by its number, e.g. `unaccept 2` (reply `accepted` to see the numbers).';
const ACCEPT_USAGE = 'Accept the CVEs of rows like this: `accept 2 4`, optionally with a reason: `accept 2 because not reachable`.';

/**
 * Accepted-CVE list: `accepted` (list the entries) and `unaccept <n>` (remove one). A reply starting
 * with either word is always answered here — valid, or `invalid` with a usage reason — never handed on.
 */
function parseAcceptedListReply(reply: string): ImportReplyAction | null {
  const n = normalizeReply(reply);
  if (n === IMPORT_COMMANDS.accepted) return { kind: 'listAccepted' };
  const unaccept = n.match(/^unaccept(?: (.*))?$/);
  if (!unaccept) return null;
  const position = /^\d+$/.test(unaccept[1] ?? '') ? Number(unaccept[1]) : 0;
  return position > 0 ? { kind: 'unaccept', position } : { kind: 'invalid', reason: UNACCEPT_USAGE };
}

/** `accept <rows> [because <reason>]` on the New screen; the reason keeps the casing the user typed. */
function parseAcceptReply(reply: string, ctx: ImportReplyContext): ImportReplyAction | null {
  const trimmed = reply.trim().replace(/\s+/g, ' ');
  const match = trimmed.match(/^accept(?: (.*))?$/i);
  if (!match) return null;
  const [rowsPart, ...reasonParts] = (match[1] ?? '').split(/ because /i);
  const tokens = rowsPart.toLowerCase().replace(/ because$/, '').split(/[\s,]+/).filter(Boolean);
  if (tokens.length === 0) return { kind: 'invalid', reason: ACCEPT_USAGE };
  const rows = matchVisibleNewRows(tokens, ctx, 'accepted');
  if ('reason' in rows) return { kind: 'invalid', reason: rows.reason };
  const reason = reasonParts.join(' because ').trim();
  return reason ? { kind: 'accept', ids: rows.ids, reason } : { kind: 'accept', ids: rows.ids };
}

/** Shared by every group screen: back/done and cancellation words (KTD2). */
function parseGroupExit(reply: string, ctx: ImportReplyContext): ImportReplyAction | null {
  const n = normalizeReply(reply);
  if (n === IMPORT_COMMANDS.done) return ctx.singleGroup ? { kind: 'done' } : { kind: 'back' };
  if (n === IMPORT_COMMANDS.back || isCancellation(reply)) return ctx.singleGroup ? { kind: 'done' } : { kind: 'back' };
  return null;
}

export function parseNewGroupReply(reply: string, ctx: ImportReplyContext): ImportReplyAction {
  const n = normalizeReply(reply);
  if (n === IMPORT_COMMANDS.create || isConfirmation(reply)) return { kind: 'create' };
  const exit = parseGroupExit(reply, ctx);
  if (exit) return exit;
  const nav = parseReviewPageNav(reply);
  if (nav) return { kind: 'pageNav', nav };
  const bulk = parseBulkNewRowReply(reply);
  if (bulk !== null) return { kind: 'bulk', include: bulk };
  if (ctx.canFold) {
    const fold = parseFoldReply(reply, ctx);
    if (fold) return fold;
  }
  if (ctx.canAccept) {
    const accepted = parseAcceptReply(reply, ctx) ?? parseAcceptedListReply(reply);
    if (accepted) return accepted;
  }
  const ids = parseStrictRowToggle(reply, ctx.newRowIds);
  return ids ? { kind: 'toggleRows', ids } : { kind: 'invalid' };
}

/**
 * Finding folding: `merge <ids>` and `unmerge <id>` on the New screen. Page-local like every other
 * New-screen reply (R5): an id that is not a New row on the visible page is rejected, naming it. A
 * reply starting with either word is always answered here (valid or `invalid` with a reason), never
 * handed to the row-toggle parse, so a typo cannot half-apply.
 */
function parseFoldReply(reply: string, ctx: ImportReplyContext): ImportReplyAction | null {
  const n = normalizeReply(reply);
  const merge = n.match(/^merge(?: (.*))?$/);
  if (merge) {
    const rows = matchVisibleNewRows((merge[1] ?? '').split(/[\s,]+/).filter(Boolean), ctx, 'merged');
    if ('reason' in rows) return { kind: 'invalid', reason: rows.reason };
    return rows.ids.length >= 2
      ? { kind: 'merge', ids: rows.ids }
      : { kind: 'invalid', reason: 'Merge needs at least two different row numbers, e.g. `merge 2 4`.' };
  }
  if (n === 'add' || n.startsWith('add ')) return parseAddReply(n, ctx);
  const unmerge = n.match(/^unmerge(?: (\S+))?$/);
  if (unmerge) {
    const token = unmerge[1] ?? '';
    const id = (ctx.mergedRowIds ?? []).find(m => m.toLowerCase() === token);
    return id
      ? { kind: 'unmerge', id }
      : { kind: 'invalid', reason: token ? `Row ${token.toUpperCase()} isn't a merged row on this page.` : 'Unmerge needs a merged row number, e.g. `unmerge 2`.' };
  }
  return null;
}

/** The distinct row ids named by `tokens`, each of which must be a New row on the visible page (else the reason, naming it). */
function matchVisibleNewRows(tokens: string[], ctx: ImportReplyContext, verb: 'merged' | 'added' | 'accepted'): { ids: string[] } | { reason: string } {
  const byLower = new Map(ctx.newRowIds.map(id => [id.toLowerCase(), id]));
  const ids: string[] = [];
  for (const token of tokens) {
    const id = byLower.get(token);
    if (!id) return { reason: `Row ${token.toUpperCase()} isn't a New row on this page, so it can't be ${verb}.` };
    if (!ids.includes(id)) ids.push(id);
  }
  return { ids };
}

const ADD_USAGE = 'Add rows to a ticket like this: `add 2 4 to PROJ-123`, then choose Comment or Rewrite.';

/** `add <ids> to <KEY>` with an optional `as comment` / `as rewrite` (normalized, lower-cased input). */
function parseAddReply(n: string, ctx: ImportReplyContext): ImportReplyAction {
  const match = n.match(/^add (.+?) to ([a-z][a-z0-9_]*-\d+)(?: as (comment|rewrite))?$/);
  if (!match) return { kind: 'invalid', reason: ADD_USAGE };
  const rows = matchVisibleNewRows(match[1].split(/[\s,]+/).filter(Boolean), ctx, 'added');
  if ('reason' in rows) return { kind: 'invalid', reason: rows.reason };
  const { ids } = rows;
  if (ids.length === 0) return { kind: 'invalid', reason: ADD_USAGE };
  const key = match[2].toUpperCase();
  return match[3] ? { kind: 'add', ids, key, mode: match[3] as AddMode } : { kind: 'addPrompt', ids, key };
}

/** Everything the add prompt shows about the target ticket and what a rewrite would drop. */
export interface AddPromptInput {
  key: string;
  summary: string;
  status: string | null;
  resolved: boolean;
  ids: string[];
  rowCount: number;
  /** Findings the ticket recorded that a rewrite's description would no longer cover. */
  droppedKeys: string[];
  baseUrl?: string;
}

/**
 * Finding folding (KTD5/KTD13): the first step of `add … to <KEY>` — the target ticket, a resolved
 * warning, the overwrite warning with the findings a rewrite would drop, and two links that resend
 * the command with the mode. Clicking one is the confirmation. The ticket's summary, status and the
 * dropped keys come from Jira, so each is neutralized before it lands in this trusted response.
 */
export function buildAddPrompt(input: AddPromptInput): string {
  // Jira-sourced text on a trusted screen: besides [text](url) links, angle-bracket autolinks
  // (<command:…>) are defused too — backslashes first, so the text's own "\<" cannot un-escape ours.
  const safe = (value: string) => neutralizeMarkdownLinks(value.replace(/\r?\n/g, ' ')).replace(/\\/g, '\\\\').replace(/</g, '\\<');
  const rows = input.ids.join(',');
  const command = (mode: AddMode) => `add ${rows} to ${input.key} as ${mode}`;
  const lines: string[] = [
    `### Add ${input.rowCount} ${input.rowCount === 1 ? 'row' : 'rows'} to ${formatKeyLink(input.key, input.baseUrl)}`,
    '',
    `**${input.key}** — ${safe(input.summary)}${input.status ? ` (${safe(input.status)})` : ''}`,
    '',
  ];
  if (input.resolved) {
    lines.push('⚠ This ticket is resolved. You can still add to it, but nobody may be watching it.');
    lines.push('');
  }
  lines.push(`- ${cmdLink('Comment', command('comment'))} — posts one comment listing the added findings and adds their record labels. The description and title stay as they are.`);
  lines.push(`- ${cmdLink('Rewrite', command('rewrite'))} — **overwrites the description and title** with the findings of this report, adds the record labels, and posts a comment listing what was added.`);
  if (input.droppedKeys.length > 0) {
    lines.push('');
    lines.push(`Rewrite would drop these findings the ticket currently records, because the report does not cover them here: ${input.droppedKeys.map(safe).join(', ')}.`);
  }
  lines.push('');
  lines.push('Either choice also changes this ticket\'s labels. Nothing is written until you pick one.');
  return lines.join('\n');
}

/**
 * Finding folding: after a page is rebuilt from `allRows` (which keeps the originals), puts each
 * of `merged` back in place of its members when all of them are still on the page. A merged row
 * whose members were split across pages falls back to its originals. Pure.
 */
export function restoreMergedRows<TRow extends ReviewRowBase>(rows: TRow[], merged: TRow[]): TRow[] {
  return merged.reduce((acc, row) => {
    const ids = new Set(row.memberIds ?? [row.id]);
    const members = acc.filter(r => r.existingTicketKey === null && ids.has(r.id));
    if (members.length !== ids.size) return acc;
    return acc.flatMap(r => (r === members[0] ? [row] : members.includes(r) ? [] : [r]));
  }, rows);
}

/**
 * Finding folding (KTD3): replaces the named visible New rows with one merged row. It keeps the
 * first member's id and position, lists every original id in `memberIds` (a member that is itself
 * merged contributes all of its originals) and starts included. `buildFields` supplies the
 * importer-specific fields from the members; identity and fold bookkeeping are set here so no
 * importer can get them wrong. Already-ticketed rows are never merged, even when named. Pure.
 */
export function mergeNewRows<TRow extends ReviewRowBase>(
  rows: TRow[],
  ids: string[],
  buildFields: (members: TRow[]) => Omit<TRow, keyof ReviewRowBase>,
): TRow[] {
  const wanted = new Set(ids);
  const members = rows.filter(r => r.existingTicketKey === null && wanted.has(r.id));
  if (members.length < 2) return rows;
  const merged = {
    ...buildFields(members),
    id: members[0].id,
    existingTicketKey: null,
    included: true,
    memberIds: members.flatMap(m => m.memberIds ?? [m.id]),
  } as unknown as TRow;
  const memberSet = new Set(members);
  return rows.flatMap(r => (r === members[0] ? [merged] : memberSet.has(r) ? [] : [r]));
}

/**
 * Finding folding: puts a merged row's original rows (still held, untouched, in `allRows`) back in
 * its place. A row that is not merged, or whose originals are missing, leaves `rows` unchanged. Pure.
 */
export function unmergeNewRow<TRow extends ReviewRowBase>(rows: TRow[], allRows: TRow[], id: string): TRow[] {
  const merged = rows.find(r => r.existingTicketKey === null && r.id === id && r.memberIds !== undefined);
  if (!merged) return rows;
  const originals = merged.memberIds!
    .map(memberId => allRows.find(a => a.existingTicketKey === null && a.id === memberId))
    .filter((r): r is TRow => r !== undefined);
  if (originals.length !== merged.memberIds!.length) return rows;
  return rows.flatMap(r => (r === merged ? originals : [r]));
}

// Accepted spellings of each row action (after normalizeReply lower-casing).
const TICKETED_ACTION_WORDS: Record<string, TicketedAction> = {
  'update': 'update',
  'follow-up': 'follow-up', 'followup': 'follow-up', 'follow up': 'follow-up',
  'rewrite': 'rewrite',
  're-create': 're-create', 'recreate': 're-create', 're create': 're-create',
  'leave': 'leave',
};

/** isConfirmation()'s paging/expand phrases — not assent, so they must never trigger `apply`
 * (up to a batch of Jira writes) on the Already-ticketed screen. */
const NON_ASSENT_CONFIRMATIONS = new Set(['load all', 'load more', 'show all', 'show more']);

/**
 * U4/KTD7: the Already-ticketed screen's replies. Commands and row actions are matched first and
 * the exit/cancellation words last, so an offered option is never swallowed by a cancel word (see
 * docs/solutions/logic-errors/confirm-cancel-word-list-broadening-swallows-domain-name-collisions.md).
 * Confirmation words mean `apply` — the screen's single run action. A bare row id no longer toggles
 * anything and is invalid, as is an action the row does not offer (or a finished row, AE6).
 */
export function parseTicketedGroupReply(reply: string, ctx: ImportReplyContext): ImportReplyAction {
  const n = normalizeReply(reply);
  const assent = isConfirmation(reply) && !NON_ASSENT_CONFIRMATIONS.has(reply.trim().toLowerCase());
  if (n === IMPORT_COMMANDS.apply || assent) return { kind: 'apply' };
  if (n === IMPORT_COMMANDS.update || n === LEGACY_UPDATE_COMMAND) return { kind: 'update' };
  if (n === IMPORT_COMMANDS.recreate) return { kind: 'recreate' };

  const match = n.match(/^(\S+) (.+)$/);
  const action = match ? TICKETED_ACTION_WORDS[match[2]] : undefined;
  if (match && action) {
    const target = match[1];
    if (target === 'all') {
      return ctx.ticketedRows.some(r => r.allowedActions.includes(action))
        ? { kind: 'setAllActions', action }
        : { kind: 'invalid', reason: `No row can be set to \`${action}\`.` };
    }
    const row = ctx.ticketedRows.find(r => r.id.toLowerCase() === target);
    if (row) {
      return row.allowedActions.includes(action)
        ? { kind: 'setAction', id: row.id, action }
        : { kind: 'invalid', reason: `${row.id} can't be set to \`${action}\` — it offers ${row.allowedActions.map(a => `\`${a}\``).join(', ')}.` };
    }
  }

  const exit = parseGroupExit(reply, ctx);
  if (exit) return exit;
  // An import with no overview has no other screen to list the accepted entries from.
  const listing = ctx.canAccept && ctx.singleGroup ? parseAcceptedListReply(reply) : null;
  if (listing) return listing;
  return { kind: 'invalid' };
}

export function parseStaleGroupReply(reply: string, ctx: ImportReplyContext): ImportReplyAction {
  const n = normalizeReply(reply);
  if (n === IMPORT_COMMANDS.close || isConfirmation(reply)) return { kind: 'close' };
  const exit = parseGroupExit(reply, ctx);
  if (exit) return exit;
  const listing = ctx.canAccept && ctx.singleGroup ? parseAcceptedListReply(reply) : null;
  if (listing) return listing;
  if (!ctx.stale) return { kind: 'invalid' };
  const toggle = parseStaleTicketToggle(reply, ctx.stale);
  // A reply mixing a ticket key with anything else is rejected whole rather than half-applied.
  if (!toggle || toggle.remainder.trim().length > 0) return { kind: 'invalid' };
  return { kind: 'toggleStale', keys: toggle.matched };
}

/** Parses a reply against the vocabulary of the screen currently shown — and only that one (R6). */
export function parseImportReviewReply(view: ImportReviewView, reply: string, ctx: ImportReplyContext): ImportReplyAction {
  switch (view) {
    case 'new': return parseNewGroupReply(reply, ctx);
    case 'ticketed': return parseTicketedGroupReply(reply, ctx);
    case 'stale': return parseStaleGroupReply(reply, ctx);
    default: return parseOverviewReply(reply, ctx);
  }
}

/** One-line reminder of what the current screen accepts, for the "didn't understand" reply. */
export function describeImportReplyVocabulary(view: ImportReviewView, ctx: ImportReplyContext): string {
  const exit = ctx.singleGroup ? '`done`' : '`back`';
  switch (view) {
    case 'new':
      return `On this screen you can reply \`create tickets\`, row numbers to toggle (e.g. \`2 4\`), \`include all\` / \`exclude all\`, ` +
        `${ctx.canFold ? '`merge 2 4` / `unmerge 2`, `add 2 4 to PROJ-123`, ' : ''}` +
        `${ctx.canAccept ? '`accept 2 4`, `accepted` / `unaccept 2`, ' : ''}\`next\` / \`prev\`, or ${exit}.`;
    case 'ticketed':
      return 'On this screen you can reply `apply`, `<row> <action>` (e.g. `A2 follow-up` — actions are ' +
        `${TICKETED_ACTION_ORDER.map(a => `\`${a}\``).join(', ')}), \`all <action>\` (e.g. \`all leave\`), ` +
        `\`update tickets\`, \`re-create tickets\`, or ${exit}.`;
    case 'stale':
      return `On this screen you can reply \`close tickets\`, a stale ticket's key to toggle it (e.g. \`PROJ-123\`), or ${exit}.`;
    default: {
      const opens = ctx.groups.map(g => `\`${g === 'new' ? IMPORT_COMMANDS.openNew : g === 'ticketed' ? IMPORT_COMMANDS.openTicketed : IMPORT_COMMANDS.openStale}\``);
      return `On the overview you can reply ${[...opens, ...(ctx.canAccept ? ['`accepted`', '`unaccept 2`'] : []), '`done`'].join(', ')}.`;
    }
  }
}

/** Import summary streamed on "done" (R3), from the session's accumulated outcomes. */
export function buildImportDoneSummary(outcomes: ImportOutcomes): string {
  const { followedUp } = outcomes;
  const parts = [
    `**${outcomes.created}** created`,
    `${outcomes.updated} updated`,
    `${followedUp} follow-up${followedUp === 1 ? '' : 's'}`,
    `${outcomes.recreated} re-created`,
    `${outcomes.closed} closed`,
  ];
  if (outcomes.added > 0) parts.push(`${outcomes.added} added to existing tickets`);
  if (outcomes.rewritten > 0) parts.push(`${outcomes.rewritten} rewritten`);
  const failed = outcomes.createFailed + outcomes.recreateFailed + outcomes.updateFailed + outcomes.followUpFailed + outcomes.closeFailed + outcomes.addFailed + outcomes.rewriteFailed;
  if (failed > 0) parts.push(`${failed} failed`);
  return `Import finished — ${parts.join(', ')}.`;
}
