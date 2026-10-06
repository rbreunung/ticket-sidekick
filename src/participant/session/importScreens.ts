// Report-import overview hub: view state, group counts and the New/Already-ticketed/Stale screens.
// Pure (vscode-free); re-exported through ../sessionState.ts.

import { BATCH_LIMIT } from '../../utils/reportImport';
import type { RowChange } from '../../utils/reportImport';
import { formatKeyLink } from '../../services/TicketService';
import type { AcceptedEntry } from '../../utils/waltzAccepted';
import { AcceptedHidden, ImportResultGroup, ImportReviewView, ReviewRowBase, ReviewSession, ReviewSessionStale, TicketedAction, TicketedRowResult, emptyImportOutcomes, isTicketedRowFinished, selectedStaleIssueTypes, ticketedRowActions, ticketedTargetKey } from './importTypes';
import { ReviewTableColumn, cmdLink, countedNoun, neutralizeMarkdownLinks, pluralNoun, renderReviewTable, safeCellText } from './primitives';
import { buildReviewPage } from './reviewPaging';

// ---------------------------------------------------------------------------------------------
// Overview hub (docs/plans/2026-09-23-1400-feat-report-import-overview-hub-plan.md): an import's
// results are split into up to three groups — New, Already ticketed, Stale — shown first as an
// overview, then one group per screen, each with its own reply vocabulary and its own action(s).
// Nothing is created, updated, re-created or closed except by an action chosen inside its group
// (R11). Everything below is pure (no vscode) so the renderers and parsers are Vitest-covered.
// ---------------------------------------------------------------------------------------------

/** Exact-match command words (KTD2). Chosen disjoint from isConfirmation()/isCancellation(), from
 * row ids (digits, `A<n>`) and ticket keys (always hyphenated), and from page-nav/bulk tokens. */
export const IMPORT_COMMANDS = {
  openNew: 'open new',
  openTicketed: 'open already ticketed',
  openStale: 'open stale',
  done: 'done',
  back: 'back',
  create: 'create tickets',
  update: 'update tickets',
  recreate: 're-create tickets',
  apply: 'apply',
  close: 'close tickets',
  accepted: 'accepted',
} as const;

// Pre-overview-hub spelling of the update action — still accepted on the Already-ticketed screen so
// a user (or a clicked link in an older transcript) typing the old words is not rejected.
export const LEGACY_UPDATE_COMMAND = 'update existing tickets';

/** The result groups that have at least one row — the basis for R1 (evaluated once, at build). */
export function computeImportResultGroups<TRow extends ReviewRowBase>(
  allRows: TRow[],
  stale?: ReviewSessionStale,
): ImportResultGroup[] {
  const groups: ImportResultGroup[] = [];
  if (allRows.some(r => r.existingTicketKey === null)) groups.push('new');
  if (allRows.some(r => r.existingTicketKey !== null)) groups.push('ticketed');
  if (stale && (stale.groups.some(g => g.tickets.length > 0) || stale.ineligible.length > 0)) groups.push('stale');
  return groups;
}

/**
 * KTD7: fixes the session's groups, single-group flag and initial view once, when the session is
 * built. Exactly one group (or none) → that group opens directly with "Done" and there is no
 * overview (R4); two or three → the overview comes first (R1).
 */
export function initImportViewState<TRow extends ReviewRowBase>(session: ReviewSession<TRow>): ReviewSession<TRow> {
  const groups = computeImportResultGroups(session.allRows, session.staleTickets);
  const singleGroup = groups.length <= 1;
  const view: ImportReviewView = singleGroup ? (groups[0] ?? 'new') : 'overview';
  return { ...session, groups, singleGroup, view, outcomes: emptyImportOutcomes() };
}

/** Fills in view state for a session built without it (e.g. by a test or an older call site). */
export function ensureImportViewState<TRow extends ReviewRowBase>(session: ReviewSession<TRow>): ReviewSession<TRow> {
  if (session.view !== undefined && session.groups !== undefined && session.singleGroup !== undefined && session.outcomes !== undefined) {
    return session;
  }
  const initial = initImportViewState(session);
  return {
    ...session,
    view: session.view ?? initial.view,
    groups: session.groups ?? initial.groups,
    singleGroup: session.singleGroup ?? initial.singleGroup,
    outcomes: session.outcomes ?? initial.outcomes,
  };
}

/** Live per-group counts the screens and parsers share. */
export interface ImportGroupCounts {
  newRemaining: number; // every not-yet-created new row, across all pages
  newIncludedOnPage: number; // what "Create N tickets" would create now
  ticketedTotal: number;
  ticketedOpen: number; // already-ticketed rows whose action has not run yet — still worth opening the screen for
  ticketedChanged: number; // already-ticketed rows with a change (new findings, rating rise or baseline)
  pendingActions: number; // unfinished already-ticketed rows not on `leave` — what `apply` would run
  pendingUpdates: number; // ... of those, set to `update` (the `update tickets` shortcut)
  pendingRecreates: number; // ... of those, set to `re-create` (the `re-create tickets` shortcut)
  staleOpen: number; // eligible stale tickets not closed yet
  staleSelected: number; // what "Close N tickets" would close now
  staleIneligible: number;
}

export function countImportGroups<TRow extends ReviewRowBase>(session: ReviewSession<TRow>): ImportGroupCounts {
  const ticketed = session.allRows.filter(r => r.existingTicketKey !== null);
  const open = ticketed.filter(r => !isTicketedRowFinished(r));
  const closed = new Set(session.staleTickets?.closedKeys ?? []);
  const staleTickets = (session.staleTickets?.groups ?? []).flatMap(g => g.tickets).filter(t => !closed.has(t.key));
  return {
    newRemaining: session.allRows.filter(r => r.existingTicketKey === null).length,
    newIncludedOnPage: session.rows.filter(r => r.existingTicketKey === null && r.included).length,
    ticketedTotal: ticketed.length,
    ticketedOpen: open.length,
    ticketedChanged: ticketed.filter(r => r.change != null).length,
    pendingActions: open.filter(r => ticketedRowActions(r).action !== 'leave').length,
    pendingUpdates: open.filter(r => ticketedRowActions(r).action === 'update').length,
    pendingRecreates: open.filter(r => ticketedRowActions(r).action === 're-create').length,
    staleOpen: staleTickets.length,
    staleSelected: staleTickets.filter(t => t.included).length,
    staleIneligible: session.staleTickets?.ineligible.length ?? 0,
  };
}

export interface ImportScreenOptions {
  baseUrl?: string;
  itemNoun: string; // e.g. 'flaw(s)' — pluralized for display
  // What one new finding on an already-ticketed row is called in its Change cell, e.g. 'flaw(s)' /
  // 'CVE(s)' (U4/R5). Defaults to 'finding(s)'.
  findingNoun?: string;
  // Finding folding: whether the New screen offers merge/unmerge (Veracode, Waltz; not email).
  canFold?: boolean;
  // Accepted-CVE list: whether the New screen offers `accept` (Waltz only).
  canAccept?: boolean;
}

const pluralize = (n: number, singular: string, plural: string): string => `${n} ${n === 1 ? singular : plural}`;

function describeAcceptedHidden(hidden: AcceptedHidden): string {
  const parts: string[] = [];
  if (hidden.cves > 0) parts.push(`${pluralize(hidden.cves, 'accepted CVE', 'accepted CVEs')} hidden`);
  if (hidden.belowFloor > 0) parts.push(`${pluralize(hidden.belowFloor, 'component', 'components')} below the rating floor`);
  return parts.join(' · ');
}

/**
 * Accepted-CVE list (R7, R10): the line saying what the list kept off the New screen, with a link to
 * list the entries. Empty when nothing was hidden. Shown on the overview and, when there is no
 * overview, on the group screen itself, so the count is never invisible.
 */
export function buildAcceptedHiddenLine(hidden: AcceptedHidden | undefined): string {
  if (!hidden || (hidden.cves === 0 && hidden.belowFloor === 0)) return '';
  return `_${describeAcceptedHidden(hidden)}_ — ${cmdLink('Show accepted', IMPORT_COMMANDS.accepted)}`;
}

/** Said when the accepted list leaves nothing in any group, instead of the filter-mismatch message. */
export function buildAllHiddenMessage(hidden: AcceptedHidden): string {
  return `Nothing is left to import: ${describeAcceptedHidden(hidden)} (see \`.jira-oss-accepted.json\`). ` +
    'Remove an entry from that file, or lower the rating floor, to see those findings again.';
}

/** "Back to overview" normally; "Done" when the import has a single group and no overview (R4). */
function groupScreenExitLine(singleGroup: boolean): string {
  return singleGroup
    ? `Reply ${cmdLink('Done', IMPORT_COMMANDS.done)} when you are finished with this import.`
    : `Reply ${cmdLink('Back to overview', IMPORT_COMMANDS.back)} to see the other results.`;
}

/**
 * R1/R2/R3/R15: the overview — one line per group that had rows when the session was built, with
 * its count, what already happened to it, and an "open" link while it still has something to act
 * on. A fully handled group stays listed with its outcome and no link.
 */
export function buildImportOverview<TRow extends ReviewRowBase>(session: ReviewSession<TRow>, opts: ImportScreenOptions): string {
  const s = ensureImportViewState(session);
  const c = countImportGroups(s);
  const o = s.outcomes!;
  const lines: string[] = ['### Import results', ''];

  for (const group of s.groups!) {
    const parts: string[] = [];
    let link = '';
    if (group === 'new') {
      if (o.created > 0) parts.push(`${o.created} created`);
      if (o.added > 0) parts.push(`${o.added} added to existing tickets`);
      if (o.createFailed + o.addFailed > 0) parts.push(`${o.createFailed + o.addFailed} failed`);
      parts.push(o.created + o.createFailed + o.added + o.addFailed > 0 ? `${c.newRemaining} left` : countedNoun(c.newRemaining, opts.itemNoun));
      if (c.newRemaining > 0) link = cmdLink('Review & create', IMPORT_COMMANDS.openNew);
      lines.push(`- **New** — ${parts.join(' · ')}${link ? ` — ${link}` : ''}`);
    } else if (group === 'ticketed') {
      parts.push(countedNoun(c.ticketedTotal, opts.itemNoun));
      if (c.ticketedChanged > 0) parts.push(`${c.ticketedChanged} with changes`);
      if (o.updated > 0) parts.push(`${o.updated} updated`);
      if (o.followedUp > 0) parts.push(`${o.followedUp} follow-up${o.followedUp === 1 ? '' : 's'}`);
      if (o.rewritten > 0) parts.push(`${o.rewritten} rewritten`);
      if (o.recreated > 0) parts.push(`${o.recreated} re-created`);
      const failed = o.updateFailed + o.followUpFailed + o.recreateFailed + o.rewriteFailed;
      if (failed > 0) parts.push(`${failed} failed`);
      if (c.ticketedOpen > 0) link = cmdLink('Review', IMPORT_COMMANDS.openTicketed);
      lines.push(`- **Already ticketed** — ${parts.join(' · ')}${link ? ` — ${link}` : ''}`);
    } else {
      parts.push(`${c.staleOpen} open`);
      if (c.staleIneligible > 0) parts.push(`${c.staleIneligible} not closable (no discovered workflow)`);
      if (o.closed > 0) parts.push(`${o.closed} closed`);
      if (o.closeFailed > 0) parts.push(`${o.closeFailed} failed`);
      if (c.staleOpen > 0 || c.staleIneligible > 0) link = cmdLink('Review & close', IMPORT_COMMANDS.openStale);
      lines.push(`- **Stale tickets** (finding no longer in the report) — ${parts.join(' · ')}${link ? ` — ${link}` : ''}`);
    }
  }

  const hiddenLine = buildAcceptedHiddenLine(s.acceptedHidden);
  if (hiddenLine) lines.push('', hiddenLine);
  lines.push('');
  lines.push('_Open a group to review it. Nothing is created, updated or closed until you choose an action inside that group._');
  lines.push('');
  lines.push(`Reply ${cmdLink('Done', IMPORT_COMMANDS.done)} to finish this import.`);
  return lines.join('\n');
}

/** R5/R7: the New group — table, per-row toggles, include/exclude all, paging, "Create N tickets". */
export function buildNewGroupScreen<TRow extends ReviewRowBase>(
  session: ReviewSession<TRow>,
  columns: ReviewTableColumn<TRow>[],
  opts: ImportScreenOptions,
): string {
  const s = ensureImportViewState(session);
  const fresh = s.rows.filter(r => r.existingTicketKey === null);
  const { totalPages } = buildReviewPage(s.allRows, s.page);
  const lines: string[] = ['### New — will create'];

  const hiddenLine = buildAcceptedHiddenLine(s.acceptedHidden);
  if (fresh.length === 0) {
    lines.push(`_No new ${pluralNoun(opts.itemNoun)} left to create._`);
    lines.push('');
    if (hiddenLine) lines.push(hiddenLine, '');
    lines.push(groupScreenExitLine(s.singleGroup!));
    return lines.join('\n');
  }

  const freshColumns: ReviewTableColumn<TRow>[] = [
    { header: '#', accessor: (r) => r.id },
    ...columns,
    { header: 'Include?', accessor: (r) => cmdLink(r.included ? '✓' : '_excluded_', r.id) },
  ];
  lines.push(renderReviewTable(freshColumns, fresh));
  lines.push(
    `Reply ${cmdLink('Include all', 'include all')} / ${cmdLink('Exclude all', 'exclude all')} to set every row on this page.`,
  );
  lines.push('');
  if (opts.canFold) {
    lines.push('Reply `merge 2 4` to combine rows on this page into one ticket, `unmerge 2` to split a merged row, or `add 2 4 to PROJ-123` to add rows to an existing ticket.');
    lines.push('');
  }
  if (opts.canAccept) {
    lines.push('Reply `accept 2 4` to hide those rows\' CVEs from this and future imports (add `because …` to record why), or `accepted` to list what is accepted.');
    lines.push('');
  }
  if (hiddenLine) {
    lines.push(hiddenLine);
    lines.push('');
  }
  if (totalPages > 1) {
    lines.push(
      `_Page ${s.page + 1} of ${totalPages}._ Reply ${cmdLink('next', 'next')} / ${cmdLink('prev', 'prev')} or \`page <n>\` to navigate.`,
    );
    lines.push('');
  }
  const n = fresh.filter(r => r.included).length;
  lines.push(`**${n}** ticket(s) will be created.`);
  lines.push('');
  lines.push(
    (n > 0 ? `Reply ${cmdLink(`Create ${n} tickets`, IMPORT_COMMANDS.create)} to create them, or ` : 'Reply ') +
    'a list of row numbers to toggle (e.g. `2 4`).',
  );
  lines.push(groupScreenExitLine(s.singleGroup!));
  return lines.join('\n');
}

/** U4/R5: one-line summary of what changed on an already-ticketed row, e.g. "+2 CVEs, High→Critical". */
export function formatRowChange(change: RowChange | null | undefined, findingNoun = 'finding(s)'): string {
  if (!change) return '—';
  if (change.kind === 'baseline') return 'baseline';
  const parts: string[] = [];
  if (change.newIds.length > 0) parts.push(`+${countedNoun(change.newIds.length, findingNoun)}`);
  // Rating text derives from Jira labels (untrusted) and lands in a trusted table cell.
  if (change.ratingRise) parts.push(`${safeCellText(change.ratingRise.from)}→${safeCellText(change.ratingRise.to)}`);
  return parts.length > 0 ? parts.join(', ') : '—';
}

/** U4/R16: a row's result as shown in its Action cell (and in the per-row progress lines). */
export function formatTicketedRowResult(result: TicketedRowResult, baseUrl?: string): string {
  if (result.status === 'failed') return `✗ ${result.action} failed: ${safeCellText(result.error)}`;
  switch (result.action) {
    case 'update':
      if (result.note === 'baseline') return 'baseline recorded';
      if (result.note === 'up-to-date') return 'already up to date';
      if (result.note === 'comment-failed') return 'updated (labels only — comment failed)';
      return 'updated';
    case 'rewrite':
      return result.note === 'comment-failed' ? 'rewritten (comment failed)' : 'rewritten';
    case 'follow-up':
      return `follow-up ${formatKeyLink(result.key, baseUrl)}${result.linkMissing ? ' (link missing)' : ''}`;
    case 're-create':
      return `re-created as ${formatKeyLink(result.key, baseUrl)}`;
  }
}

/**
 * U4/R8: sets `action` on one already-ticketed row (`target` = its id) or on every row (`'all'`).
 * Only unfinished rows that offer the action change; everything else (new rows, finished rows, rows
 * not offering it) is returned untouched. Pure — the handler applies it to `rows` and `allRows`.
 */
export function applyTicketedActionChange<TRow extends ReviewRowBase>(
  rows: TRow[],
  target: string | 'all',
  action: TicketedAction,
): TRow[] {
  return rows.map(r => {
    if (r.existingTicketKey === null || isTicketedRowFinished(r)) return r;
    if (target !== 'all' && r.id !== target) return r;
    if (!ticketedRowActions(r).allowedActions.includes(action)) return r;
    return { ...r, action };
  });
}

/** KTD9: every allowed action as its own link (sending `<row id> <action>`), the current one first and bold. */
function ticketedActionCell(row: ReviewRowBase, baseUrl?: string): string {
  if (row.result?.status === 'done') return formatTicketedRowResult(row.result, baseUrl);
  const { allowedActions, action } = ticketedRowActions(row);
  const ordered = [action, ...allowedActions.filter(a => a !== action)];
  const links = ordered.map(a => (a === action ? `**${cmdLink(a, `${row.id} ${a}`)}**` : cmdLink(a, `${row.id} ${a}`)));
  const prefix = row.result?.status === 'failed' ? `${formatTicketedRowResult(row.result, baseUrl)} — ` : '';
  return prefix + links.join(' · ');
}

function ticketedTicketCell(row: ReviewRowBase, baseUrl?: string): string {
  const key = ticketedTargetKey(row);
  const others = (row.ticketKeys?.length ?? 1) - 1;
  return `${formatKeyLink(key, baseUrl)}${others > 0 ? ` (+${others} more)` : ''}`;
}

/**
 * U4/R5/R8-R10 (KTD9): the Already-ticketed group — one row per already-ticketed item with its
 * target ticket, that ticket's status, what changed and a per-row Action cell; `apply` runs every
 * unfinished row not on `leave`, and the `update tickets` / `re-create tickets` shortcuts run only
 * the rows set to that action.
 */
export function buildTicketedGroupScreen<TRow extends ReviewRowBase>(
  session: ReviewSession<TRow>,
  columns: ReviewTableColumn<TRow>[],
  opts: ImportScreenOptions,
): string {
  const s = ensureImportViewState(session);
  const ticketed = s.allRows.filter(r => r.existingTicketKey !== null);
  const c = countImportGroups(s);
  const lines: string[] = ['### Already ticketed'];

  const ticketedColumns: ReviewTableColumn<TRow>[] = [
    { header: '#', accessor: (r) => r.id },
    ...columns,
    { header: 'Ticket', accessor: (r) => ticketedTicketCell(r, opts.baseUrl) },
    { header: 'Status', accessor: (r) => safeCellText(r.target?.status ?? '—') },
    { header: 'Change', accessor: (r) => formatRowChange(r.change, opts.findingNoun) },
    { header: 'Action', accessor: (r) => ticketedActionCell(r, opts.baseUrl) },
  ];
  lines.push(renderReviewTable(ticketedColumns, ticketed));
  lines.push('');

  if (c.pendingActions > 0) {
    lines.push(`Reply ${cmdLink(`Apply ${c.pendingActions} actions`, IMPORT_COMMANDS.apply)} to run every row not set to leave.`);
    if (c.pendingActions > BATCH_LIMIT) {
      lines.push(`_Only the first ${BATCH_LIMIT} rows run per reply — reply \`apply\` again for the rest._`);
    }
    const shortcuts: string[] = [];
    if (c.pendingUpdates > 0) shortcuts.push(cmdLink(`Update ${c.pendingUpdates} tickets`, IMPORT_COMMANDS.update));
    if (c.pendingRecreates > 0) shortcuts.push(cmdLink(`Re-create ${c.pendingRecreates} tickets`, IMPORT_COMMANDS.recreate));
    if (shortcuts.length > 0) lines.push(`Or run only one kind: ${shortcuts.join(' / ')}.`);
  } else {
    lines.push(c.ticketedOpen > 0
      ? '_Every row is set to leave — nothing to apply._'
      : '_Every row has been handled — nothing to apply._');
  }
  if (c.ticketedOpen > 0) {
    lines.push('Change a row with `<row> <action>` (e.g. `A2 follow-up`) or every row with `all <action>` (e.g. `all leave`), or click an action in the table.');
  }
  lines.push(groupScreenExitLine(s.singleGroup!));
  return lines.join('\n');
}

/** R5/R9: the Stale group — per-ticket toggles (off by default) and "Close N tickets". The target
 * and resolution are picked when closing (stale-ticket target pick plan, R1), one issue type per
 * run (R12), so the table shows each ticket's issue type instead of a fixed target. */
export function buildStaleGroupScreen<TRow extends ReviewRowBase>(session: ReviewSession<TRow>, opts: ImportScreenOptions): string {
  const s = ensureImportViewState(session);
  const stale: ReviewSessionStale = s.staleTickets ?? { groups: [], ineligible: [], resolutionOptions: [] };
  const closed = new Set(stale.closedKeys ?? []);
  const c = countImportGroups(s);

  interface StaleRow {
    key: string;
    summary: string;
    issueType: string;
    currentStatus: string;
    toggleCell: string;
  }
  const rows: StaleRow[] = [];
  for (const group of stale.groups) {
    for (const t of group.tickets) {
      rows.push({
        key: formatKeyLink(t.key, opts.baseUrl),
        summary: neutralizeMarkdownLinks(t.summary),
        issueType: group.issueType,
        currentStatus: t.currentStatus,
        toggleCell: closed.has(t.key) ? '✓ closed' : cmdLink(t.included ? '✓ close' : '_no_', t.key),
      });
    }
  }
  for (const t of stale.ineligible) {
    rows.push({
      key: formatKeyLink(t.key, opts.baseUrl),
      summary: neutralizeMarkdownLinks(t.summary),
      issueType: '',
      currentStatus: t.currentStatus,
      toggleCell: `_excluded — ${neutralizeMarkdownLinks(t.note)}_`,
    });
  }

  const columns: ReviewTableColumn<StaleRow>[] = [
    { header: 'Key', accessor: r => r.key },
    { header: 'Summary', accessor: r => r.summary },
    { header: 'Type', accessor: r => r.issueType },
    { header: 'Status', accessor: r => r.currentStatus },
    { header: 'Close?', accessor: r => r.toggleCell },
  ];

  const lines: string[] = ['### Stale — no longer in the report, may be closed'];
  lines.push(renderReviewTable(columns, rows));
  lines.push('');
  if (c.staleOpen > 0) {
    if (c.staleSelected > 0) {
      lines.push(`Reply ${cmdLink(`Close ${c.staleSelected} tickets`, IMPORT_COMMANDS.close)} to transition the tickets marked ✓ close — you pick the target status next.`);
      if (selectedStaleIssueTypes(stale).length > 1) {
        lines.push('The selection spans several issue types: each run closes one issue type, and you are asked which one first.');
      }
    } else {
      lines.push('Close 0 tickets — reply a ticket key (e.g. `PROJ-123`) to mark it for closing.');
    }
  }
  lines.push(groupScreenExitLine(s.singleGroup!));
  return lines.join('\n');
}

/** Renders whichever screen the session's `view` names. */
export function buildImportScreen<TRow extends ReviewRowBase>(
  session: ReviewSession<TRow>,
  columns: ReviewTableColumn<TRow>[],
  opts: ImportScreenOptions,
): string {
  const s = ensureImportViewState(session);
  // With no overview, the Already-ticketed or Stale screen is the only place to see what the accepted list hid.
  const withHiddenLine = (screen: string): string => {
    const line = s.singleGroup ? buildAcceptedHiddenLine(s.acceptedHidden) : '';
    return line ? `${screen}\n\n${line}` : screen;
  };
  switch (s.view) {
    case 'new': return buildNewGroupScreen(s, columns, opts);
    case 'ticketed': return withHiddenLine(buildTicketedGroupScreen(s, columns, opts));
    case 'stale': return withHiddenLine(buildStaleGroupScreen(s, opts));
    default: return buildImportOverview(s, opts);
  }
}

/** Accepted-CVE list (R7): the entries numbered in file order, each with a link that removes it. */
export function buildAcceptedList(entries: AcceptedEntry[]): string {
  if (entries.length === 0) return '_The accepted list is empty._';
  const text = (value: string): string => neutralizeMarkdownLinks(value).replace(/\s+/g, ' ').trim();
  const lines = entries.map((e, i) =>
    `${i + 1}. ${text(e.component)} · ${text(e.cve)}${e.reason ? ` — ${text(e.reason)}` : ''} — ${cmdLink('Remove', `unaccept ${i + 1}`)}`);
  return ['### Accepted CVEs', '', ...lines].join('\n');
}
