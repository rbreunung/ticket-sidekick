import * as path from 'path';
import type { BoardKind, CheckMode, Validated } from '../../sessions/boardKind';
import { handlerOf } from './handlers';
import { IMPORT_HANDLERS } from './registry';
import { newGroupRefs } from './newTab';
import { browseUrl } from './searchExport';
import type { DerivedPart, Session } from '../../sessions/sessionTypes';
import { normalizeProjectKey } from '../../services/configValidation';
import { buildReviewPage } from '../../imports/rows';
import type { AcceptedHidden, TicketedAction } from '../../imports/types';
import { countedNoun } from '../../utils/chatPrimitives';
import type { DateKind } from '../../utils/waltzDates';
import {
  isEmailRow, isLeftOut, newRows, readImport, rowKeyOf, slicesOf, staleTickets, ticketedRows,
  type ImportData, type ImportDeps, type ImportRow, type ImportTab, type SliceEntry,
} from './read';
import {
  IMPORT_KIND, REPORT_KIND_LABELS, emailRecipe, importSourceKey, isReportKind, normaliseReportPath, recipePaths, type ImportRecipe,
} from './recipe';

// The import board: a Veracode or Waltz report against Jira, one tab per group (New, Already
// ticketed, Stale, and Accepted for Waltz), or a batch of emails, which has the New tab only. A check after a restart or another change keeps a tab
// with unfinished choices as the developer saw it and marks it out of date; Refresh then takes the
// fresh reading and keeps every choice whose rows still exist. The board's own recorded writes
// never count as a change. vscode-free.

export type { ImportTab } from './read';

/** The developer's choices, keyed by row key (a row's sorted dedup keys) or ticket key, never by row id. */
export interface ImportChoices {
  /** New rows left out of the create. */
  excluded: string[];
  /** Likely repeats (emails) the developer took into the create; a likely repeat starts left out. */
  included?: string[];
  /** New rows merged into one ticket, each by its members' row keys in order. */
  merges: string[][];
  /** Already-ticketed actions the developer chose in place of the default. */
  actions: Record<string, TicketedAction>;
  /** Stale tickets selected for closing. */
  staleSelected: string[];
}

/** A ticket a New create made, with the dedup keys it covered. */
export interface CreatedRecord {
  dedupKeys: string[];
  key: string;
}

/** An existing ticket the board wrote: Jira's `updated` read right after the write, so a later check knows the change was its own. */
export interface TicketWriteRecord {
  updated?: string;
  /** Only labels and a comment were added: the ticket's Already-ticketed rows still need their own decision. */
  commentOnly?: boolean;
}

/** What the board wrote, saved after each write while an Apply runs. */
export interface ImportWrites {
  created: CreatedRecord[];
  tickets: Record<string, TicketWriteRecord>;
  /** The accepted list's fingerprint after the board's own last write to it. */
  acceptedFile?: string;
  /** Already-ticketed rows (by row key) a per-row write finished, such as a follow-up, which settles that row and not the ticket's others. */
  rows?: string[];
}

export interface ImportWorking {
  /** The tab in view; null until the developer picks one, so the opening tab applies. */
  tab: ImportTab | null;
  /** A text filter per tab, matched against the row's reference and summary. */
  filters: Partial<Record<ImportTab, string>>;
  /** Already ticketed: only the rows that need a decision, or all; null until chosen. */
  ticketedShow: 'decision' | 'all' | null;
  /** Tabs a background check found changed while they had unfinished choices: they offer only Refresh. */
  outOfDate: ImportTab[];
  /** The choices the last Refresh could not keep, named for the developer. */
  dropped: string[];
  choices: ImportChoices;
  writes: ImportWrites;
  /** State the area handlers keep for themselves (a running ticket merge, a search), each under its handler's name. */
  ext: Record<string, unknown>;
}

/** The actions the kind handles itself. */
export type KnownImportAction =
  | { type: 'tab'; tab: ImportTab }
  | { type: 'filter'; tab: ImportTab; text: string }
  | { type: 'ticketed-show'; show: 'decision' | 'all' }
  | { type: 'dismiss-dropped' };

/** A kind action, or an action one of the area handlers takes (selection, merge, actions, accept, close, search). */
export type ImportAction = KnownImportAction | ({ type: string } & Record<string, unknown>);

export interface ImportTabView {
  id: ImportTab;
  label: string;
  count: number;
  outOfDate: boolean;
  /** Why the tab cannot be used now. */
  unavailable?: string;
  /** The one line shown when the tab has no rows. */
  empty?: string;
  warning?: string;
  hasWork: boolean;
}

export interface NewRowView {
  id: string;
  ref: string;
  summary: string;
  rating: string;
  included: boolean;
  /** The number of the merge this row is part of, counted from 1. */
  merge?: number;
  /** What the plan lines and results of this row's ticket are named: the row's own reference, or its merge's. */
  group: string;
  /** The ticket the board created for this row, or added it to. */
  created?: string;
  /** That ticket's page in Jira. */
  createdUrl?: string;
  /** An email whose subject is already these tickets' summary; it starts left out of the create. */
  repeatOf?: Array<{ key: string; summary: string; url: string | null }>;
}

export interface TicketedRowView {
  id: string;
  ref: string;
  summary: string;
  ticket: string;
  status: string | null;
  resolved: boolean;
  url: string | null;
  /** The finding's other open tickets, when it has more than one; absent otherwise. */
  alsoOpen?: Array<{ key: string; url: string | null }>;
  change: string | null;
  action: TicketedAction;
  allowedActions: TicketedAction[];
  needsDecision: boolean;
  written: boolean;
}

export interface StaleRowView {
  key: string;
  summary: string;
  status: string;
  issueType: string;
  url: string | null;
  selected: boolean;
  /** Why the ticket cannot be closed from the board. */
  note?: string;
  written: boolean;
}

export interface AcceptedRowView {
  component: string;
  cve?: string;
  version?: string;
  reason?: string;
}

export interface ImportView {
  title: string;
  reportKind: string;
  reportFile: string;
  reportPath: string;
  project: string;
  template: string;
  issueType: string;
  tabs: ImportTabView[];
  /** The tab in view. */
  tab: ImportTab;
  /** The first tab with work, in the order New, Already ticketed, Stale. */
  openingTab: ImportTab;
  /** No tab has work left. */
  finished: boolean;
  /** The filter of the tab in view. */
  filter: string;
  new?: { rows: NewRowView[] };
  ticketed?: { show: 'decision' | 'all'; rows: TicketedRowView[] };
  stale?: { rows: StaleRowView[] };
  accepted?: { rows: AcceptedRowView[]; warning: string | null };
  dropped: string[];
  notices: string[];
  /** What the accepted list kept off New and Already ticketed (Waltz), e.g. "2 accepted CVEs hidden"; absent when nothing. */
  acceptedHidden?: string;
  /** Fields the area handlers add, each under its handler's name. */
  ext: Record<string, unknown>;
}

type ImportSession = Session<ImportRecipe, ImportData, ImportWorking>;

const TAB_LABELS: Record<ImportTab, string> = { new: 'New', ticketed: 'Already ticketed', stale: 'Stale', accepted: 'Accepted' };
const EMPTY: Record<ImportTab, string> = {
  new: 'No new findings: every item of this report already has a ticket.',
  ticketed: 'No item of this report has a ticket yet.',
  stale: 'No open ticket is stale: each one still has its finding in this report.',
  accepted: 'Nothing is accepted.',
};
const STALE_UNAVAILABLE = 'The search for stale tickets failed, so this tab is not available. Refresh to try again.';
const MAX_TEXT = 255;
const MAX_FILTER = 200;

const EMAIL_EMPTY = 'No emails to import: none of the files could be read.';
/** How many email files one import takes at most. */
const MAX_EMAIL_FILES = 50;

function tabsOf(recipe: ImportRecipe): ImportTab[] {
  if (recipe.kind === 'email') return ['new'];
  return recipe.kind === 'waltz' ? ['new', 'ticketed', 'stale', 'accepted'] : ['new', 'ticketed', 'stale'];
}

/** An import's title: the report file, or the one email or the number of emails. */
function importTitle(recipe: ImportRecipe): string {
  const files = recipePaths(recipe);
  const source = recipe.kind === 'email' && files.length > 1 ? `${files.length} emails` : path.basename(recipe.reportPath);
  return `${REPORT_KIND_LABELS[recipe.kind]} import: ${source}`;
}

function text(value: unknown, max = MAX_TEXT): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= max ? trimmed : undefined;
}

/** A recipe in its accepted shape: a known kind, a project key, an absolute report path, a template and an issue type. */
function recipeOf(value: unknown): Validated<ImportRecipe> {
  const v = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  if (!isReportKind(v.kind)) return { ok: false, reason: 'the import names no report kind the board knows (veracode, waltz or email).' };
  const projectKey = typeof v.projectKey === 'string' ? normalizeProjectKey(v.projectKey) : undefined;
  if (!projectKey) return { ok: false, reason: 'the import names no valid Jira project key.' };
  const fullPath = (p: unknown): p is string => typeof p === 'string' && path.isAbsolute(p) && p.length <= 4096;
  const templateName = text(v.templateName);
  const issueType = text(v.issueType);
  if (v.kind === 'email') {
    const files = Array.isArray(v.reportPaths) ? v.reportPaths : fullPath(v.reportPath) ? [v.reportPath] : [];
    if (files.length === 0 || files.length > MAX_EMAIL_FILES || !files.every(fullPath)) {
      return { ok: false, reason: `the import names no email files by their full paths (at most ${MAX_EMAIL_FILES}).` };
    }
    if (!templateName) return { ok: false, reason: 'the import names no template.' };
    if (!issueType) return { ok: false, reason: 'the import names no issue type.' };
    return { ok: true, recipe: emailRecipe({ projectKey, templateName, issueType }, files) };
  }
  if (!fullPath(v.reportPath)) {
    return { ok: false, reason: 'the import names no report file by its full path.' };
  }
  if (!templateName) return { ok: false, reason: 'the import names no template.' };
  if (!issueType) return { ok: false, reason: 'the import names no issue type.' };
  return { ok: true, recipe: { kind: v.kind, projectKey, reportPath: normaliseReportPath(v.reportPath), templateName, issueType } };
}

/** How a row is named to the developer: its flaw ids, its component, or its email's file. */
export function rowRef(row: ImportRow): string {
  if ('issueIds' in row) return `Flaw ${row.issueIds.join(', ')}`;
  if (isEmailRow(row)) return path.basename(row.emlFilePath);
  return row.nameVersion;
}

function rowRating(row: ImportRow): string {
  if ('issueIds' in row) return row.severityLabelText;
  return isEmailRow(row) ? '' : row.maxVulnRating;
}

/** The notice naming an email import's files that are gone, leaving out the ones the board deleted after creating their tickets. */
function missingFilesNotice(data: ImportData, writes: ImportWrites): string | undefined {
  const created = createdKeySet(writes);
  const missing = (data.missingFiles ?? []).filter(f => !created.has(f));
  if (missing.length === 0) return undefined;
  return `${countedNoun(missing.length, 'email file(s)')} no longer there: ${missing.map(f => path.basename(f)).join(', ')}. Their emails are not on the board.`;
}

const DATE_LABELS: Record<DateKind, string> = { policy: 'Policy date', planned: 'Planned date', attestation: 'Attestation date', due: 'Due Date' };

function describeAcceptedHidden(hidden: AcceptedHidden | undefined): string | undefined {
  if (!hidden) return undefined;
  const parts: string[] = [];
  if (hidden.cves > 0) parts.push(`${countedNoun(hidden.cves, 'accepted CVE(s)')} hidden`);
  if ((hidden.components ?? 0) > 0) parts.push(`${countedNoun(hidden.components!, 'accepted component(s)')} hidden`);
  if (hidden.belowFloor > 0) parts.push(`${countedNoun(hidden.belowFloor, 'component(s)')} below the rating floor`);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

function describeChange(row: ImportRow): string | null {
  const change = row.change;
  if (!change) return null;
  if (change.kind === 'baseline') return 'Not recorded on the ticket yet';
  const parts: string[] = [];
  if (change.newIds.length > 0) parts.push(`New: ${change.newIds.join(', ')}`);
  if (change.ratingRise) parts.push(`Rating ${change.ratingRise.from} → ${change.ratingRise.to}`);
  // Recorded on the ticket → given by the report now.
  for (const d of change.dates ?? []) {
    parts.push(`${DATE_LABELS[d.date]} ${d.from ?? (d.date === 'due' ? 'missing' : 'none')} → ${d.to ?? 'none'}`);
  }
  if (change.droppedMembers) parts.push(`${change.droppedMembers} no longer in the report`);
  return parts.join('; ') || 'Changed';
}

function createdKeySet(writes: ImportWrites): Set<string> {
  return new Set(writes.created.flatMap(c => c.dedupKeys));
}

/** The ticket the board created for a row whose dedup keys it recorded, if any. */
function createdFor(writes: ImportWrites, rowKey: string): string | undefined {
  const keys = rowKey.split('\n');
  return writes.created.find(c => keys.every(k => c.dedupKeys.includes(k)))?.key;
}

function isCreated(created: Set<string>, rowKey: string): boolean {
  return rowKey.split('\n').every(k => created.has(k));
}

/** Whether the board wrote a ticket in a way that settles its Already-ticketed rows (a comment-only add does not). */
export function decided(writes: ImportWrites, ticket: string): boolean {
  const record = writes.tickets[ticket];
  return record !== undefined && !record.commentOnly;
}

/** Whether the board's writes settled an Already-ticketed row: a write that settles its ticket, or a per-row write of the row itself. */
export function rowWritten(data: ImportData, writes: ImportWrites, row: ImportRow): boolean {
  return decided(writes, row.target?.key ?? row.existingTicketKey!) || (writes.rows ?? []).includes(rowKeyOf(data, row));
}

function needsDecision(data: ImportData, row: ImportRow, writes: ImportWrites): boolean {
  return row.change !== null && row.change !== undefined && !rowWritten(data, writes, row) && row.result?.status !== 'done';
}

function eligibleStale(data: ImportData): string[] {
  return (data.review.staleTickets?.groups ?? []).flatMap(g => g.tickets.map(t => t.key));
}

function hasWork(data: ImportData, writes: ImportWrites, choices: ImportChoices, tab: ImportTab): boolean {
  if (tab === 'new') {
    const created = createdKeySet(writes);
    return newRows(data).some(r => {
      const key = rowKeyOf(data, r);
      return !isCreated(created, key) && !isLeftOut(data, choices, key);
    });
  }
  if (tab === 'ticketed') return ticketedRows(data).some(r => needsDecision(data, r, writes));
  if (tab === 'stale') return !data.staleFailed && eligibleStale(data).some(key => !decided(writes, key));
  return false;
}

/** Whether a tab has work left, counting what the area handlers still hold. */
function tabHasWork(session: ImportSession, tab: ImportTab): boolean {
  const { data } = session.derived;
  const { writes, choices } = session.working;
  return hasWork(data, writes, choices, tab) || IMPORT_HANDLERS.some(h => h.hasWork?.(session, tab) ?? false);
}

function openingTab(session: ImportSession): ImportTab {
  return (['new', 'ticketed', 'stale'] as ImportTab[]).find(tab => tabHasWork(session, tab)) ?? 'new';
}

/** Whether a tab holds choices not applied yet, which a fresh reading must not take away unseen. */
function hasUnfinishedChoices(data: ImportData, working: ImportWorking, tab: ImportTab): boolean {
  const { choices, writes } = working;
  if (tab === 'new') {
    const keys = new Set(newRows(data).map(r => rowKeyOf(data, r)));
    const created = createdKeySet(writes);
    const open = (key: string) => keys.has(key) && !isCreated(created, key);
    return choices.excluded.some(open) || (choices.included ?? []).some(open) || choices.merges.some(m => m.some(open));
  }
  if (tab === 'ticketed') {
    const rows = new Map(ticketedRows(data).map(r => [rowKeyOf(data, r), r]));
    return Object.keys(choices.actions).some(key => {
      const row = rows.get(key);
      return row !== undefined && !rowWritten(data, writes, row);
    });
  }
  if (tab === 'stale') return choices.staleSelected.some(key => !decided(writes, key));
  return false;
}

const sameUpdated = (a?: string, b?: string) => a === undefined || b === undefined || a === b;

/**
 * The tabs whose slice differs between the stored and the fresh reading, after taking off what the
 * board's own recorded writes explain: a ticket created for recorded dedup keys, or a ticket whose
 * `updated` is the one recorded after the board wrote it.
 */
function changedTabs(stored: DerivedPart<ImportData>, fresh: DerivedPart<ImportData>, writes: ImportWrites, tabs: ImportTab[]): Set<ImportTab> {
  const before = slicesOf(stored.data);
  const now = slicesOf(fresh.data);
  const created = createdKeySet(writes);
  const createdTickets = new Set(writes.created.map(c => c.key));
  const own = (ticket: string | undefined, updated: string | undefined) => {
    const record = ticket ? writes.tickets[ticket] : undefined;
    return record !== undefined && record.updated !== undefined && record.updated === updated;
  };
  const changed = new Set<ImportTab>();

  const notCreated = (slice: Map<string, SliceEntry>) => new Map([...slice].filter(([key]) => !isCreated(created, key)));
  const a = notCreated(before.new);
  const b = notCreated(now.new);
  if (a.size !== b.size || [...a].some(([key, entry]) => b.get(key)?.sig !== entry.sig)) changed.add('new');

  for (const key of new Set([...before.ticketed.keys(), ...now.ticketed.keys()])) {
    const s = before.ticketed.get(key);
    const f = now.ticketed.get(key);
    if (f && !s) {
      if (isCreated(created, key) && f.ticket !== undefined && createdTickets.has(f.ticket)) continue;
    } else if (s && !f) {
      if (s.ticket && writes.tickets[s.ticket]) continue;
    } else if (s && f) {
      if (s.sig === f.sig && s.ticket === f.ticket && sameUpdated(s.updated, f.updated)) continue;
      if (s.ticket === f.ticket && own(f.ticket, f.updated)) continue;
      // A new ticket the board created for this row: the row now points at it instead of the ticket it replaced.
      if (s.ticket !== f.ticket && s.ticket && writes.tickets[s.ticket] && own(f.ticket, f.updated)) continue;
    }
    changed.add('ticketed');
    break;
  }

  if (!fresh.data.staleFailed) {
    for (const key of new Set([...before.stale.keys(), ...now.stale.keys()])) {
      const s = before.stale.get(key);
      const f = now.stale.get(key);
      if (s && !f && writes.tickets[key]) continue;
      if (s && f && ((s.sig === f.sig && sameUpdated(s.updated, f.updated)) || own(key, f.updated))) continue;
      changed.add('stale');
      break;
    }
  }

  if (tabs.includes('accepted') && before.accepted.get('list')?.sig !== now.accepted.get('list')?.sig
    && writes.acceptedFile !== fresh.fingerprints.accepted) changed.add('accepted');
  return changed;
}

/** The reading with the fresh slice for the tabs in `take` and the stored slice for the others. */
function compose(stored: DerivedPart<ImportData>, fresh: DerivedPart<ImportData>, take: Set<ImportTab>, tabs: ImportTab[]): DerivedPart<ImportData> {
  if (tabs.every(tab => take.has(tab))) return fresh;
  const pick = (tab: ImportTab) => (take.has(tab) ? fresh.data : stored.data);
  const nd = pick('new');
  const td = pick('ticketed');
  const sd = pick('stale');
  const ad = tabs.includes('accepted') ? pick('accepted') : fresh.data;
  const allRows = [...newRows(nd), ...ticketedRows(td)];
  const rowKeys: Record<string, string[]> = {};
  for (const row of newRows(nd)) rowKeys[row.id] = nd.rowKeys[row.id];
  for (const row of ticketedRows(td)) rowKeys[row.id] = td.rowKeys[row.id];
  const updated: Record<string, string> = {};
  for (const row of ticketedRows(td)) {
    const key = row.target?.key ?? row.existingTicketKey!;
    if (td.updated[key]) updated[key] = td.updated[key];
  }
  for (const t of staleTickets(sd)) if (sd.updated[t.key]) updated[t.key] = sd.updated[t.key];
  const page = buildReviewPage(allRows, 0);
  const { acceptedHidden: _hidden, staleTickets: _stale, staleCandidates: _candidates, ...ticketedReview } = td.review;
  const data: ImportData = {
    ...fresh.data,
    review: {
      ...ticketedReview,
      allRows, rows: page.rows, page: page.page,
      ticketInfo: { ...(stored.data.review.ticketInfo ?? {}), ...(fresh.data.review.ticketInfo ?? {}) },
      ...(nd.review.acceptedHidden ? { acceptedHidden: nd.review.acceptedHidden } : {}),
      ...(sd.review.staleTickets ? { staleTickets: sd.review.staleTickets } : {}),
      ...(sd.review.staleCandidates ? { staleCandidates: sd.review.staleCandidates } : {}),
    },
    rowKeys, updated,
    accepted: ad.accepted,
    staleFailed: sd.staleFailed,
    descriptionsUnread: td.descriptionsUnread,
    // The export lists one reading; while a tab keeps its stored slice, so does the export.
    export: stored.data.export,
  };
  const fingerprints = { ...stored.fingerprints };
  for (const tab of take) fingerprints[`tab:${tab}`] = fresh.fingerprints[`tab:${tab}`];
  return { readAt: stored.readAt, fingerprints, data };
}

/**
 * The board's writes as a fresh reading of another report file at the same path sees them: each
 * written ticket keeps the `updated` that tells its own change apart, but no longer counts as
 * decided, because the new scan's rows were never decided on. The New creates stay recorded.
 */
function writesFor(session: ImportSession, fresh: DerivedPart<ImportData>): ImportWrites {
  const { writes } = session.working;
  const before = session.derived.fingerprints.report;
  const now = fresh.fingerprints.report;
  if (before === undefined || now === undefined || before === now) return writes;
  const tickets = Object.fromEntries(Object.entries(writes.tickets).map(([key, record]) => [key, { ...record, commentOnly: true }]));
  const { rows: _rows, ...rest } = writes;
  return { ...rest, tickets };
}

/** Lays the stored choices over a fresh reading: keeps each whose rows still exist and names the others. */
function keepChoices(session: ImportSession, fresh: ImportData): { choices: ImportChoices; dropped: string[] } {
  const stored = session.derived.data;
  const { choices } = session.working;
  const dropped: string[] = [];
  const refOf = (key: string) => {
    const row = stored.review.allRows.find(r => rowKeyOf(stored, r) === key);
    return row ? rowRef(row) : key.split('\n').join(', ');
  };
  const freshNew = new Set(newRows(fresh).map(r => rowKeyOf(fresh, r)));
  const freshTicketed = new Map(ticketedRows(fresh).map(r => [rowKeyOf(fresh, r), r]));
  const why = (key: string) => {
    const row = freshTicketed.get(key);
    return row ? `it has a ticket now (${row.target?.key ?? row.existingTicketKey})` : 'it is no longer a new row';
  };

  // A row the board created a ticket for has had its choice carried out: it goes without a message.
  const created = createdKeySet(session.working.writes);
  const excluded = choices.excluded.filter(key => {
    if (freshNew.has(key)) return true;
    if (isCreated(created, key)) return false;
    dropped.push(`${refOf(key)}: leaving it out of the create was dropped, because ${why(key)}.`);
    return false;
  });
  const merges = choices.merges.filter(merge => {
    const gone = merge.find(key => !freshNew.has(key));
    if (gone === undefined) return true;
    if (merge.every(key => isCreated(created, key))) return false;
    dropped.push(`The merge of ${merge.map(refOf).join(' and ')} was dropped, because for ${refOf(gone)} ${why(gone)}.`);
    return false;
  });
  const actions: Record<string, TicketedAction> = {};
  for (const [key, action] of Object.entries(choices.actions)) {
    const row = freshTicketed.get(key);
    if (row && (row.allowedActions ?? []).includes(action)) actions[key] = action;
    else dropped.push(`${refOf(key)}: the action "${action}" was dropped, because ${row ? 'the row no longer offers it' : 'the row is no longer on Already ticketed'}.`);
  }
  const stillStale = new Set(eligibleStale(fresh));
  const staleSelected = choices.staleSelected.filter(key => {
    if (stillStale.has(key)) return true;
    dropped.push(`${key}: its selection for closing was dropped, because it is no longer a stale ticket the board can close.`);
    return false;
  });
  const included = (choices.included ?? []).filter(key => freshNew.has(key));
  return { choices: { excluded, ...(included.length > 0 ? { included } : {}), merges, actions, staleSelected }, dropped };
}

function matches(filter: string | undefined, ...fields: Array<string | null | undefined>): boolean {
  if (!filter) return true;
  const needle = filter.toLowerCase();
  return fields.some(f => (f ?? '').toLowerCase().includes(needle));
}


export const importKind: BoardKind<ImportRecipe, ImportData, ImportWorking, ImportAction, ImportView, ImportDeps> = {
  kind: IMPORT_KIND,
  formatVersion: 1,
  title: recipe => importTitle(recipe),

  validate: async (input, deps) => {
    const checked = recipeOf(input);
    if (!checked.ok) return checked;
    if (!(await deps.jiraConfigured())) return { ok: false, reason: 'Jira is not set up in that window\'s Ticket Sidekick settings.' };
    return checked;
  },

  // After an update the stored import is opened again from its kind, project and file, with the
  // template and issue type it was started with; the settings are not read again.
  revalidate: async stored => recipeOf(stored),

  sourceKey: recipe => importSourceKey(recipe),
  sourceLabel: recipe => (recipe.kind === 'email'
    ? `${countedNoun(recipePaths(recipe).length, 'email file(s)')} (${recipePaths(recipe).map(f => path.basename(f)).join(', ')}) in ${recipe.projectKey}`
    : `${REPORT_KIND_LABELS[recipe.kind]} report ${recipe.reportPath} in ${recipe.projectKey}`),

  initialWorking: () => ({
    tab: null, filters: {}, ticketedShow: null, outOfDate: [], dropped: [],
    choices: { excluded: [], merges: [], actions: {}, staleSelected: [] },
    writes: { created: [], tickets: {} },
    ext: {},
  }),

  read: (recipe, deps) => readImport(recipe, deps),

  reconcile: (current, fresh, mode: CheckMode) => {
    const tabs = tabsOf(current.recipe);
    const session: ImportSession = { ...current, working: { ...current.working, writes: writesFor(current, fresh) } };
    if (mode === 'refresh') {
      // A running ticket merge works from the Already-ticketed reading it started from: a Refresh
      // takes every other tab and leaves that one marked until the merge ends.
      if (IMPORT_HANDLERS.some(h => h.blocksPlans?.(session))) {
        const take = new Set(tabs.filter(tab => tab !== 'ticketed'));
        const derived = compose(session.derived, fresh, take, tabs);
        const kept = keepChoices(session, derived.data);
        return { derived, working: { ...session.working, ...kept, outOfDate: ['ticketed'] }, conflicts: [] };
      }
      const kept = keepChoices(session, fresh.data);
      return { derived: fresh, working: { ...session.working, ...kept, outOfDate: [] }, conflicts: [] };
    }
    const changed = changedTabs(session.derived, fresh, session.working.writes, tabs);
    const marked = tabs.filter(tab => changed.has(tab)
      && (hasUnfinishedChoices(session.derived.data, session.working, tab) || IMPORT_HANDLERS.some(h => h.unfinished?.(session, tab) ?? false)));
    const take = new Set(tabs.filter(tab => !marked.includes(tab)));
    return { derived: compose(session.derived, fresh, take, tabs), working: { ...session.working, outOfDate: marked }, conflicts: [] };
  },

  reduce: (session, generic) => {
    const tabs = tabsOf(session.recipe);
    const working = session.working;
    const action = generic as KnownImportAction;
    switch (action?.type) {
      case 'tab':
        if (!tabs.includes(action.tab)) return { ok: false, reason: 'This import has no such tab.' };
        return { ok: true, working: { ...working, tab: action.tab } };
      case 'filter': {
        if (!tabs.includes(action.tab)) return { ok: false, reason: 'This import has no such tab.' };
        if (typeof action.text !== 'string' || action.text.length > MAX_FILTER) return { ok: false, reason: `A filter is text of at most ${MAX_FILTER} characters.` };
        const filters = { ...working.filters };
        if (action.text.trim()) filters[action.tab] = action.text.trim();
        else delete filters[action.tab];
        return { ok: true, working: { ...working, filters } };
      }
      case 'ticketed-show':
        if (action.show !== 'decision' && action.show !== 'all') return { ok: false, reason: 'Show the rows that need a decision, or all rows.' };
        return { ok: true, working: { ...working, ticketedShow: action.show } };
      case 'dismiss-dropped':
        return { ok: true, working: { ...working, dropped: [] } };
      default: {
        if (typeof generic?.type !== 'string') return { ok: false, reason: 'Unknown action.' };
        for (const handler of IMPORT_HANDLERS) {
          const reduced = handler.reduce?.(session, generic as { type: string } & Record<string, unknown>);
          if (reduced) return reduced;
        }
        return { ok: false, reason: 'Unknown action.' };
      }
    }
  },

  prepare: async (session, action, deps) => {
    const read: Record<string, unknown> = {};
    if (typeof action?.type !== 'string') return read;
    for (const handler of IMPORT_HANDLERS) {
      const pending = handler.prepare?.(session, action as { type: string } & Record<string, unknown>, deps);
      if (pending) read[handler.name] = await pending;
    }
    return read;
  },

  plan: (session, action, prepared) => {
    if (typeof action?.type !== 'string') return { ok: false, reason: 'Unknown action.' };
    const read = (prepared ?? {}) as Record<string, unknown>;
    for (const handler of IMPORT_HANDLERS) {
      const planned = handler.plan?.(session, action as { type: string } & Record<string, unknown>, read[handler.name]);
      if (!planned) continue;
      if (planned.ok) {
        const blocked = IMPORT_HANDLERS.filter(h => h !== handler).map(h => h.blocksPlans?.(session)).find(Boolean);
        if (blocked) return { ok: false, reason: blocked };
      }
      return planned;
    }
    return { ok: false, reason: 'This board does not write that.' };
  },

  apply: async (session, plan, deps, progress) => {
    const name = handlerOf(plan);
    const handler = IMPORT_HANDLERS.find(h => h.name === name && h.apply);
    if (!handler?.apply) throw new Error('This board did not build that plan.');
    return handler.apply(session, plan, deps, progress);
  },

  exportFile: async (session, format, deps) => {
    for (const handler of IMPORT_HANDLERS) {
      const file = handler.exportFile?.(session, format, deps);
      if (file) return file;
    }
    throw new Error(`This board cannot save ${format} files.`);
  },

  view: session => {
    const { recipe, working } = session;
    const { data } = session.derived;
    const tabs = tabsOf(recipe);
    const { writes, choices } = working;
    const opening = openingTab(session);
    const current = working.tab && tabs.includes(working.tab) ? working.tab : opening;
    const filter = working.filters[current];
    const created = createdKeySet(writes);
    const decisions = ticketedRows(data).filter(r => needsDecision(data, r, writes)).length;

    const counts: Record<ImportTab, number> = {
      new: newRows(data).length,
      ticketed: ticketedRows(data).length,
      stale: data.staleFailed ? 0 : staleTickets(data).length,
      accepted: data.accepted?.entries.length ?? 0,
    };
    const tabViews: ImportTabView[] = tabs.map(id => {
      const unavailable = id === 'stale' && data.staleFailed ? STALE_UNAVAILABLE : undefined;
      const warning = id === 'ticketed' && data.descriptionsUnread > 0
        ? `${data.descriptionsUnread} ticket(s) could not be read to compare their dates; those rows are not checked for date changes.`
        : id === 'accepted' && data.accepted?.warning ? data.accepted.warning : undefined;
      return {
        id, label: TAB_LABELS[id], count: counts[id], outOfDate: working.outOfDate.includes(id),
        hasWork: tabHasWork(session, id),
        ...(unavailable ? { unavailable } : {}),
        ...(counts[id] === 0 && !unavailable ? { empty: recipe.kind === 'email' && id === 'new' ? EMAIL_EMPTY : EMPTY[id] } : {}),
        ...(warning ? { warning } : {}),
      };
    });

    const view: ImportView = {
      title: importKind.title(recipe),
      reportKind: REPORT_KIND_LABELS[recipe.kind],
      reportFile: data.reportFileName,
      reportPath: recipe.reportPath,
      project: recipe.projectKey,
      template: recipe.templateName,
      issueType: recipe.issueType,
      tabs: tabViews,
      tab: current,
      openingTab: opening,
      finished: tabViews.every(t => !t.hasWork),
      filter: filter ?? '',
      dropped: working.dropped,
      notices: [...data.notices, ...[missingFilesNotice(data, writes)].filter((n): n is string => n !== undefined)],
      ext: {},
    };
    const hidden = describeAcceptedHidden(data.review.acceptedHidden);
    if (hidden) view.acceptedHidden = hidden;
    for (const handler of IMPORT_HANDLERS) {
      const extra = handler.view?.(session, current);
      if (extra !== undefined) view.ext[handler.name] = extra;
    }

    if (current === 'new') {
      const mergeOf = new Map(choices.merges.flatMap((m, n) => m.map(key => [key, n + 1] as const)));
      const groupRefs = newGroupRefs(data, working);
      view.new = {
        rows: newRows(data).filter(r => matches(filter, rowRef(r), r.summary)).map(r => {
          const key = rowKeyOf(data, r);
          const createdKey = isCreated(created, key) ? createdFor(writes, key) : undefined;
          const merge = mergeOf.get(key);
          return {
            id: r.id, ref: rowRef(r), group: groupRefs.get(r.id)!, summary: r.summary, rating: rowRating(r), included: !isLeftOut(data, choices, key),
            ...(isEmailRow(r) && r.repeatOf?.length ? { repeatOf: r.repeatOf.map(t => ({ key: t.key, summary: t.summary, url: browseUrl(data.baseUrl, t.key) })) } : {}),
            ...(merge ? { merge } : {}), ...(createdKey ? { created: createdKey, ...(browseUrl(data.baseUrl, createdKey) ? { createdUrl: browseUrl(data.baseUrl, createdKey)! } : {}) } : {}),
          };
        }),
      };
    } else if (current === 'ticketed') {
      const show = working.ticketedShow ?? (decisions > 0 ? 'decision' : 'all');
      view.ticketed = {
        show,
        rows: ticketedRows(data)
          .filter(r => (show === 'all' || needsDecision(data, r, writes)) && matches(filter, rowRef(r), r.summary, r.target?.key ?? r.existingTicketKey))
          .map(r => {
            const ticket = r.target?.key ?? r.existingTicketKey!;
            const key = rowKeyOf(data, r);
            const alsoOpen = (r.openTicketKeys ?? []).map(k => ({ key: k, url: browseUrl(data.baseUrl, k) }));
            return {
              id: r.id, ref: rowRef(r), summary: r.summary, ticket, status: r.target?.status ?? null, resolved: r.target?.resolved ?? false,
              url: browseUrl(data.baseUrl, ticket), ...(alsoOpen.length > 0 ? { alsoOpen } : {}), change: describeChange(r),
              action: choices.actions[key] ?? r.action ?? 'leave', allowedActions: [...(r.allowedActions ?? ['leave'])],
              needsDecision: needsDecision(data, r, writes), written: rowWritten(data, writes, r),
            };
          }),
      };
    } else if (current === 'stale') {
      view.stale = {
        rows: data.staleFailed ? [] : staleTickets(data).filter(t => matches(filter, t.key, t.summary)).map(t => ({
          key: t.key, summary: t.summary, status: t.status, issueType: t.issueType, url: browseUrl(data.baseUrl, t.key),
          selected: choices.staleSelected.includes(t.key), written: writes.tickets[t.key] !== undefined,
          ...(t.note ? { note: t.note } : {}),
        })),
      };
    } else if (current === 'accepted') {
      view.accepted = {
        warning: data.accepted?.warning ?? null,
        rows: (data.accepted?.entries ?? []).filter(e => matches(filter, e.component, e.cve)).map(e => ({
          component: e.component,
          ...(e.cve !== undefined ? { cve: e.cve } : {}),
          ...(e.version !== undefined ? { version: e.version } : {}),
          ...(e.reason !== undefined ? { reason: e.reason } : {}),
        })),
      };
    }
    return view;
  },
};
