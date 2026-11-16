// Report-import per-screen reply parsing, merge/unmerge/add helpers, reply vocabulary and done summary.
// Pure (vscode-free); re-exported through ../sessionState.ts.

import { IMPORT_COMMANDS, LEGACY_UPDATE_COMMAND, SEARCH_USAGE, UNACCEPT_COMPONENT_WORD } from './importScreens';
import { offeredTicketedActions, type ImportCommandCaps } from './importCommands';
import { AddMode, ImportOutcomes, ImportResultGroup, ImportReviewView, ReviewSessionStale, TicketedAction, ActionLabels, actionLabelOf } from './importTypes';
import { TICKET_KEY_TOKEN, isCancellation, isConfirmation, normalizeReply } from './primitives';
import type { OverviewFormat } from '../../utils/securityOverview';
import { ReviewPageNav, parseBulkNewRowReply, parseReviewPageNav } from './reviewPaging';
import { parseStaleTicketToggle } from './staleTargets';

export { mergeNewRows, restoreMergedRows, unmergeNewRow } from '../../imports/rows';

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
  | { kind: 'unacceptEntry'; component: string; cve: string } // what a Remove link sends: the entry itself, not its position
  // Accepted components: accept the named rows' components at their version (New rows or Already-ticketed
  // `A` rows, with an optional reason), and remove a component entry by its name + version.
  | { kind: 'acceptComponent'; ids: string[]; reason?: string }
  | { kind: 'unacceptComponent'; component: string; version: string }
  // Waltz ticket merge: `merge <sources> into <survivor>`. The prompt shows the plan; the confirmed form (a trailing
  // `confirm`, sent by the prompt's link) runs it. Sides are the typed `A` ids or ticket keys, upper-cased.
  | { kind: 'mergeTicketsPrompt'; sources: string[]; target: string }
  | { kind: 'mergeTickets'; sources: string[]; target: string }
  // Waltz ticket merge: re-read the report file and rebuild the screens; the prompt warns, the confirmed form runs.
  | { kind: 'reloadPrompt' }
  | { kind: 'reload' }
  // Security overview: list this report's items by Fix Version; with a format also save them as a file.
  | { kind: 'export'; format: OverviewFormat | null }
  // Ticket search: list the review's matched open tickets whose summary contains the keyword, and re-print the current screen.
  | { kind: 'search'; keyword: string }
  | { kind: 'show' }
  | { kind: 'help' }
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
  // Ticket merge: whether the importer supports `merge … into …` and `reload report` (Waltz and Veracode).
  canMergeTickets?: boolean;
  // Security overview: whether the importer supports the `export` reply (Veracode and Waltz).
  canExport?: boolean;
  // Ticket search: whether the importer supports `search` and `show` (Veracode and Waltz; not email).
  canSearch?: boolean;
  // Ticket search: each Already-ticketed row id (lower-cased) to the key of its main ticket, so `merge <rows> into A3` resolves.
  ticketTargetKeys?: Record<string, string>;
  // How the importer names its row actions to the user (Waltz shows `follow-up` as `new ticket`); the id stays the same.
  actionLabels?: ActionLabels;
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

const MERGE_USAGE = 'Merge tickets like this: `merge A5 A6 into A3` (or ticket keys, `merge PROJ-15 into PROJ-12`). The ticket after `into` is kept; the others are closed.';
const MERGE_ON_NEW_OR_STALE = 'Merging tickets is done from the overview or the Already ticketed screen, not here. On the New screen `merge 2 4` still combines New rows.';

/**
 * Waltz ticket merge (KTD1): `merge <refs> into <ref>`, optionally followed by `confirm`. A reply starting with
 * `merge` is always answered here on the screens that offer it — valid, or `invalid` with the usage — never handed on.
 */
function parseMergeTicketsReply(reply: string): ImportReplyAction | null {
  const n = normalizeReply(reply);
  if (n !== 'merge' && !n.startsWith('merge ')) return null;
  const match = n.match(/^merge (.+?) into (\S+)(?: (confirm))?$/);
  const sources = match ? match[1].split(/[\s,]+/).filter(Boolean).map(t => t.toUpperCase()) : [];
  if (!match || sources.length === 0) return { kind: 'invalid', reason: MERGE_USAGE };
  const target = match[2].toUpperCase();
  return match[3] ? { kind: 'mergeTickets', sources, target } : { kind: 'mergeTicketsPrompt', sources, target };
}

/** `reload report` asks for the confirmation, `reload report confirm` (the prompt's link) runs it. */
function parseReloadReply(reply: string): ImportReplyAction | null {
  const n = normalizeReply(reply);
  if (n === IMPORT_COMMANDS.reload) return { kind: 'reloadPrompt' };
  if (n === `${IMPORT_COMMANDS.reload} confirm`) return { kind: 'reload' };
  return null;
}

/** New and Stale: the ticket form of `merge` points to the overview, and a single-group import can still reload from its only screen. */
function parseMergeOffScreenReply(n: string, reply: string, ctx: ImportReplyContext): ImportReplyAction | null {
  if (!ctx.canMergeTickets) return null;
  if (/^merge .+ into /.test(n)) return { kind: 'invalid', reason: MERGE_ON_NEW_OR_STALE };
  return ctx.singleGroup ? parseReloadReply(reply) : null;
}

/** `help` prints the current screen's help, on every screen of every importer. */
function parseHelpReply(reply: string): ImportReplyAction | null {
  return normalizeReply(reply) === IMPORT_COMMANDS.help ? { kind: 'help' } : null;
}

const SEARCH_ON_OTHER_SCREEN = 'Search works on the New and Already ticketed screens — open one of them first, then `search <keyword>`.';

/** `show` re-prints the screen the session is on, wherever the importer supports search. */
function parseShowReply(reply: string, ctx: ImportReplyContext): ImportReplyAction | null {
  return ctx.canSearch && normalizeReply(reply) === IMPORT_COMMANDS.show ? { kind: 'show' } : null;
}

/**
 * `search <keyword>`: the word is detected on the normalized reply, the keyword is cut from the original text so its case
 * survives. A reply starting with `search` is always answered here. `available` is false on the screens that have no search.
 */
function parseSearchReply(reply: string, ctx: ImportReplyContext, available: boolean): ImportReplyAction | null {
  if (!ctx.canSearch) return null;
  const n = normalizeReply(reply);
  if (n !== IMPORT_COMMANDS.search && !n.startsWith(`${IMPORT_COMMANDS.search} `)) return null;
  if (!available) return { kind: 'invalid', reason: SEARCH_ON_OTHER_SCREEN };
  const keyword = reply.trim().slice(IMPORT_COMMANDS.search.length).trim();
  return keyword ? { kind: 'search', keyword } : { kind: 'invalid', reason: SEARCH_USAGE };
}

/**
 * `merge <New rows> into <KEY or A id>` on the New screen: the add flow under another name. The left side counts as New rows only
 * when every token is a plain number, so `merge A5 into A3` (a ticket merge) keeps its pointer to the overview.
 */
function parseMergeIntoTicketReply(n: string, ctx: ImportReplyContext): ImportReplyAction | null {
  const match = n.match(/^merge (.+?) into (\S+)$/);
  if (!match) return null;
  const tokens = match[1].split(/[\s,]+/).filter(Boolean);
  if (tokens.length === 0 || !tokens.every(t => /^\d+$/.test(t))) return null;
  const rows = matchVisibleNewRows(tokens, ctx, 'added');
  if ('reason' in rows) return { kind: 'invalid', reason: rows.reason };
  const target = match[2];
  const targets = ctx.ticketTargetKeys ?? {};
  const key = TICKET_KEY_TOKEN.test(target) ? target.toUpperCase() : Object.hasOwn(targets, target) ? targets[target] : undefined;
  if (!key) return { kind: 'invalid', reason: `${target.toUpperCase()} isn't a ticket key or an Already-ticketed row id, so there is no ticket to merge into.` };
  return { kind: 'addPrompt', ids: rows.ids, key };
}

const EXPORT_FORMATS = new Map<string, OverviewFormat | null>([
  [IMPORT_COMMANDS.export, null],
  [IMPORT_COMMANDS.exportCsv, 'csv'],
  [IMPORT_COMMANDS.exportXlsx, 'xlsx'],
  [IMPORT_COMMANDS.exportExcel, 'xlsx'],
]);

const EXPORT_ON_GROUP_SCREEN = 'Export works from the overview — reply `back` first, then `export`.';

/** `export`, `export csv` and `export xlsx` (or `export excel`), where the importer supports them; on a group screen of a multi-group import the reply says where it works. */
function parseExportReply(reply: string, ctx: ImportReplyContext, onGroupScreen: boolean): ImportReplyAction | null {
  if (!ctx.canExport) return null;
  const n = normalizeReply(reply);
  if (!EXPORT_FORMATS.has(n)) return null;
  const format = EXPORT_FORMATS.get(n) ?? null;
  if (onGroupScreen && !ctx.singleGroup) return { kind: 'invalid', reason: EXPORT_ON_GROUP_SCREEN };
  return { kind: 'export', format };
}

export function parseOverviewReply(reply: string, ctx: ImportReplyContext): ImportReplyAction {
  const n = normalizeReply(reply);
  const help = parseHelpReply(reply);
  if (help) return help;
  if (n === IMPORT_COMMANDS.done || isCancellation(reply)) return { kind: 'done' };
  const exported = parseExportReply(reply, ctx, false);
  if (exported) return exported;
  const overviewTicketReply = parseShowReply(reply, ctx) ?? parseSearchReply(reply, ctx, false);
  if (overviewTicketReply) return overviewTicketReply;
  if (n === IMPORT_COMMANDS.openNew && ctx.groups.includes('new')) return { kind: 'open', view: 'new' };
  if (n === IMPORT_COMMANDS.openTicketed && ctx.groups.includes('ticketed')) return { kind: 'open', view: 'ticketed' };
  if (n === IMPORT_COMMANDS.openStale && ctx.groups.includes('stale')) return { kind: 'open', view: 'stale' };
  const listing = ctx.canAccept ? parseAcceptedListReply(reply) : null;
  if (listing) return listing;
  const tickets = ctx.canMergeTickets ? parseMergeTicketsReply(reply) ?? parseReloadReply(reply) : null;
  if (tickets) return tickets;
  return { kind: 'invalid' };
}

const UNACCEPT_USAGE = 'Remove an accepted entry by its number, e.g. `unaccept 2` (reply `accepted` to see the numbers).';
// `unaccept <component> <CVE>`: the CVE is the last word, the component everything before it.
const UNACCEPT_ENTRY_PATTERN = /^unaccept (.+) (\S+)$/;
const ACCEPT_USAGE = 'Accept the CVEs of rows like this: `accept CVE 2 4`, optionally with a reason: `accept CVE 2 because not reachable`.';
const ACCEPT_BARE_NEW = 'Nothing was accepted. Say what to hide: `accept CVE 2 4` hides those rows\' CVEs, `accept component 2 4` hides the whole component at that version. Add `because …` to record why.';
const ACCEPT_BARE_TICKETED = 'Nothing was accepted. `accept component A2` hides the whole component at that version; `accept CVE 2 4` hides the CVEs of New rows and works from the New screen only.';
const ACCEPT_COMPONENT_USAGE = 'Accept whole components at their version like this: `accept component 2 4` (Already ticketed: `accept component A2`), optionally with a reason: `accept component 2 because no newer version`.';
const UNACCEPT_COMPONENT_USAGE = `Remove an accepted component with the Remove link in the \`accepted\` list, or by name and version: \`${UNACCEPT_COMPONENT_WORD} netty-codec 4.1.100\`.`;
// `unaccept-component <component> <version>`: the version is the last word, the component everything before it.
const UNACCEPT_COMPONENT_PATTERN = new RegExp(`^${UNACCEPT_COMPONENT_WORD} (.+) (\\S+)$`);

/**
 * Accepted-CVE list: `accepted` (list the entries) and `unaccept <n>` (remove one). A reply starting
 * with either word is always answered here — valid, or `invalid` with a usage reason — never handed on.
 */
function parseAcceptedListReply(reply: string): ImportReplyAction | null {
  const n = normalizeReply(reply);
  if (n === IMPORT_COMMANDS.accepted) return { kind: 'listAccepted' };
  if (n === UNACCEPT_COMPONENT_WORD || n.startsWith(`${UNACCEPT_COMPONENT_WORD} `)) {
    const component = n.match(UNACCEPT_COMPONENT_PATTERN);
    return component ? { kind: 'unacceptComponent', component: component[1], version: component[2] } : { kind: 'invalid', reason: UNACCEPT_COMPONENT_USAGE };
  }
  const unaccept = n.match(/^unaccept(?: (.*))?$/);
  if (!unaccept) return null;
  const entry = n.match(UNACCEPT_ENTRY_PATTERN);
  if (entry) return { kind: 'unacceptEntry', component: entry[1], cve: entry[2] };
  const position = /^\d+$/.test(unaccept[1] ?? '') ? Number(unaccept[1]) : 0;
  return position > 0 ? { kind: 'unaccept', position } : { kind: 'invalid', reason: UNACCEPT_USAGE };
}

/** Splits what follows an accept word into lower-cased row tokens and the reason after `because`, which keeps the casing typed. */
function splitRowsAndReason(rest: string | undefined): { tokens: string[]; reason: string } {
  const [rowsPart, ...reasonParts] = (rest ?? '').split(/ because /i);
  const tokens = rowsPart.toLowerCase().replace(/ because$/, '').split(/[\s,]+/).filter(Boolean);
  return { tokens, reason: reasonParts.join(' because ').trim() };
}

/** `accept CVE <rows> [because <reason>]` on the New screen; the reason keeps the casing the user typed. */
function parseAcceptReply(reply: string, ctx: ImportReplyContext): ImportReplyAction | null {
  const trimmed = reply.trim().replace(/\s+/g, ' ');
  const match = trimmed.match(/^accept cve(?: (.*))?$/i);
  if (!match) return null;
  const { tokens, reason } = splitRowsAndReason(match[1]);
  if (tokens.length === 0) return { kind: 'invalid', reason: ACCEPT_USAGE };
  const rows = matchVisibleNewRows(tokens, ctx, 'accepted');
  if ('reason' in rows) return { kind: 'invalid', reason: rows.reason };
  return reason ? { kind: 'accept', ids: rows.ids, reason } : { kind: 'accept', ids: rows.ids };
}

/**
 * `accept component <rows> [because <reason>]` on the New screen (visible New rows) and the Already-ticketed
 * screen (its `A` rows still open). A reply starting with these words is always answered here — valid, or
 * `invalid` with a usage reason — never handed to the CVE `accept` parse.
 */
function parseAcceptComponentReply(reply: string, ctx: ImportReplyContext, view: 'new' | 'ticketed'): ImportReplyAction | null {
  const trimmed = reply.trim().replace(/\s+/g, ' ');
  const match = trimmed.match(/^accept component(?: (.*))?$/i);
  if (!match) return null;
  const { tokens, reason } = splitRowsAndReason(match[1]);
  if (tokens.length === 0) return { kind: 'invalid', reason: ACCEPT_COMPONENT_USAGE };
  const rows = view === 'new' ? matchVisibleNewRows(tokens, ctx, 'accepted') : matchOpenTicketedRows(tokens, ctx);
  if ('reason' in rows) return { kind: 'invalid', reason: rows.reason };
  return reason ? { kind: 'acceptComponent', ids: rows.ids, reason } : { kind: 'acceptComponent', ids: rows.ids };
}

/** The distinct ids named by `tokens`, each of which must be an Already-ticketed row whose action has not run yet (else the reason, naming it). */
function matchOpenTicketedRows(tokens: string[], ctx: ImportReplyContext): { ids: string[] } | { reason: string } {
  const byLower = new Map(ctx.ticketedRows.map(r => [r.id.toLowerCase(), r.id]));
  const ids: string[] = [];
  for (const token of tokens) {
    const id = byLower.get(token);
    if (!id) return { reason: `Row ${token.toUpperCase()} isn't an Already ticketed row that is still open, so it can't be accepted.` };
    if (!ids.includes(id)) ids.push(id);
  }
  return { ids };
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
  const help = parseHelpReply(reply);
  if (help) return help;
  if (n === IMPORT_COMMANDS.create || isConfirmation(reply)) return { kind: 'create' };
  const exported = parseExportReply(reply, ctx, true);
  if (exported) return exported;
  const ticketReply = parseShowReply(reply, ctx) ?? parseSearchReply(reply, ctx, true);
  if (ticketReply) return ticketReply;
  const exit = parseGroupExit(reply, ctx);
  if (exit) return exit;
  const nav = parseReviewPageNav(reply);
  if (nav) return { kind: 'pageNav', nav };
  const bulk = parseBulkNewRowReply(reply);
  if (bulk !== null) return { kind: 'bulk', include: bulk };
  const mergeInto = ctx.canFold ? parseMergeIntoTicketReply(n, ctx) : null;
  if (mergeInto) return mergeInto;
  const offScreen = parseMergeOffScreenReply(n, reply, ctx);
  if (offScreen) return offScreen;
  if (ctx.canFold) {
    const fold = parseFoldReply(reply, ctx);
    if (fold) return fold;
  }
  if (ctx.canAccept) {
    const accepted = parseAcceptComponentReply(reply, ctx, 'new') ?? parseAcceptReply(reply, ctx) ?? parseAcceptedListReply(reply);
    if (accepted) return accepted;
    // A bare `accept` names no kind, so it records nothing and says what the two spellings are.
    if (n === 'accept' || n.startsWith('accept ')) return { kind: 'invalid', reason: ACCEPT_BARE_NEW };
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

// Accepted spellings of each row action (after normalizeReply lower-casing).
const TICKETED_ACTION_WORDS: Record<string, TicketedAction> = {
  'update': 'update',
  'follow-up': 'follow-up', 'followup': 'follow-up', 'follow up': 'follow-up',
  'new ticket': 'follow-up', 'new-ticket': 'follow-up', 'newticket': 'follow-up',
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
  const help = parseHelpReply(reply);
  if (help) return help;
  const assent = isConfirmation(reply) && !NON_ASSENT_CONFIRMATIONS.has(reply.trim().toLowerCase());
  if (n === IMPORT_COMMANDS.apply || assent) return { kind: 'apply' };
  if (n === IMPORT_COMMANDS.update || n === LEGACY_UPDATE_COMMAND) return { kind: 'update' };
  if (n === IMPORT_COMMANDS.recreate) return { kind: 'recreate' };
  const exported = parseExportReply(reply, ctx, true);
  if (exported) return exported;
  const ticketReply = parseShowReply(reply, ctx) ?? parseSearchReply(reply, ctx, true);
  if (ticketReply) return ticketReply;
  const nav = parseReviewPageNav(reply);
  if (nav) return { kind: 'pageNav', nav };

  if (ctx.canAccept) {
    // Only the whole-component form exists here; any other `accept` is answered with both spellings rather than read as a row action.
    const accept = parseAcceptComponentReply(reply, ctx, 'ticketed');
    if (accept) return accept;
    if (n === 'accept' || n.startsWith('accept ')) return { kind: 'invalid', reason: ACCEPT_BARE_TICKETED };
  }

  if (ctx.canMergeTickets) {
    const tickets = parseMergeTicketsReply(reply) ?? (ctx.singleGroup ? parseReloadReply(reply) : null);
    if (tickets) return tickets;
  }

  const match = n.match(/^(\S+) (.+)$/);
  const action = match ? TICKETED_ACTION_WORDS[match[2]] : undefined;
  if (match && action) {
    const target = match[1];
    if (target === 'all') {
      return ctx.ticketedRows.some(r => r.allowedActions.includes(action))
        ? { kind: 'setAllActions', action }
        : { kind: 'invalid', reason: `No row can be set to \`${actionLabelOf(action, ctx.actionLabels)}\`.` };
    }
    const row = ctx.ticketedRows.find(r => r.id.toLowerCase() === target);
    if (row) {
      return row.allowedActions.includes(action)
        ? { kind: 'setAction', id: row.id, action }
        : { kind: 'invalid', reason: `${row.id} can't be set to \`${actionLabelOf(action, ctx.actionLabels)}\` — it offers ${row.allowedActions.map(a => `\`${actionLabelOf(a, ctx.actionLabels)}\``).join(', ')}.` };
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
  const help = parseHelpReply(reply);
  if (help) return help;
  if (n === IMPORT_COMMANDS.close || isConfirmation(reply)) return { kind: 'close' };
  const exit = parseGroupExit(reply, ctx);
  if (exit) return exit;
  const exported = parseExportReply(reply, ctx, true);
  if (exported) return exported;
  const staleTicketReply = parseShowReply(reply, ctx) ?? parseSearchReply(reply, ctx, false);
  if (staleTicketReply) return staleTicketReply;
  const listing = ctx.canAccept && ctx.singleGroup ? parseAcceptedListReply(reply) : null;
  if (listing) return listing;
  const offScreen = parseMergeOffScreenReply(n, reply, ctx);
  if (offScreen) return offScreen;
  const nav = parseReviewPageNav(reply);
  if (nav) return { kind: 'pageNav', nav };
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

/**
 * What the command catalog needs to know about a review's reply context. An importer with its own action words lists only
 * the actions some open row offers; one without lists them all.
 */
export function importCommandCaps(ctx: ImportReplyContext): ImportCommandCaps {
  return {
    singleGroup: ctx.singleGroup,
    canFold: ctx.canFold,
    canAccept: ctx.canAccept,
    canMergeTickets: ctx.canMergeTickets,
    canExport: ctx.canExport,
    canSearch: ctx.canSearch,
    actionLabels: ctx.actionLabels,
    ticketedActions: offeredTicketedActions(ctx.actionLabels, ctx.ticketedRows),
  };
}

/** Import summary streamed on "done" (R3), from the session's accumulated outcomes. */
export function buildImportDoneSummary(outcomes: ImportOutcomes, labels?: ActionLabels): string {
  const { followedUp } = outcomes;
  const parts = [
    `**${outcomes.created}** created`,
    `${outcomes.updated} updated`,
    `${followedUp} ${actionLabelOf('follow-up', labels)}${followedUp === 1 ? '' : 's'}`,
    `${outcomes.recreated} re-created`,
    `${outcomes.closed} closed`,
  ];
  if (outcomes.added > 0) parts.push(`${outcomes.added} added to existing tickets`);
  if (outcomes.rewritten > 0) parts.push(`${outcomes.rewritten} rewritten`);
  if (outcomes.merged > 0) parts.push(`${outcomes.merged} merged`);
  const failed = outcomes.createFailed + outcomes.recreateFailed + outcomes.updateFailed + outcomes.followUpFailed + outcomes.closeFailed + outcomes.addFailed + outcomes.rewriteFailed + outcomes.mergeFailed;
  if (failed > 0) parts.push(`${failed} failed`);
  return `Import finished — ${parts.join(', ')}.`;
}
