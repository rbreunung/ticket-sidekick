import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { DerivedPart } from '../../sessions/sessionTypes';
import type { OverviewTicket, ProjectVersionInfo, TicketService } from '../../services/TicketService';
import type { IJiraClient } from '../../jira/IJiraClient';
import type { ReportImportDescriptor } from '../../imports/descriptor';
import type { ImportReviewInput, ReviewBuildEvent } from '../../imports/review';
import type { ReviewRowBase, ReviewSession } from '../../imports/types';
import type { DiagLogger } from '../../utils/diagTypes';
import type { VeracodeFlaw, VeracodeReviewRow } from '../../utils/veracodeReport';
import type { WaltzComponent, WaltzReviewRow } from '../../utils/waltzReport';
import { ACCEPTED_FILE_NAME, type AcceptedEntry } from '../../utils/waltzAccepted';
import type { ImportRecipe } from './recipe';

// Reading an import: the report file through its kind's descriptor, the review build of the shared
// engine (dedup, stale tickets, the accepted list), and what the export needs from Jira, so the
// export is built from the reading the board shows. Each tab's slice gets its own fingerprint, so a
// later check can tell which tabs changed. vscode-free.

export type ImportTab = 'new' | 'ticketed' | 'stale' | 'accepted';

export type ImportRow = (VeracodeReviewRow | WaltzReviewRow) & ReviewRowBase;

export interface ImportDescriptors {
  veracode: ReportImportDescriptor<VeracodeFlaw[], VeracodeReviewRow>;
  waltz: ReportImportDescriptor<WaltzComponent[], WaltzReviewRow>;
}

/** What the import board needs around it; `jiraDeps.ts` builds it over the Jira services. */
export interface ImportDeps {
  jiraConfigured(): Promise<boolean>;
  /** The Veracode and Waltz descriptors over the current settings. */
  descriptors(): ImportDescriptors;
  baseUrl(): Promise<string | undefined>;
  /** The template's resolved default fields; `problem` says why they are empty. */
  templateFields<TItem, TRow extends ReviewRowBase>(recipe: ImportRecipe, descriptor: ReportImportDescriptor<TItem, TRow>): Promise<{ additionalFields: Record<string, unknown>; problem?: string }>;
  /** The engine's review build against Jira; `dedupFailed` when any part of the dedup search failed. */
  buildReview<TItem, TRow extends ReviewRowBase>(
    input: ImportReviewInput<TItem>, descriptor: ReportImportDescriptor<TItem, TRow>, onEvent: (event: ReviewBuildEvent) => void,
  ): Promise<{ session: ReviewSession<TRow>; dedupFailed: boolean }>;
  /** The named tickets with the fields the overview needs; throws with a worded reason. */
  overviewTickets(keys: string[], source: OverviewTicket['source']): Promise<OverviewTicket[]>;
  /** Jira's `updated` time of each named ticket; throws with a worded reason. */
  updatedTimes(keys: string[]): Promise<Record<string, string>>;
  projectVersions(projectKey: string): Promise<ProjectVersionInfo[]>;
  /** The descriptions of the named tickets; a ticket that cannot be read is null. */
  descriptions(keys: string[]): Promise<Record<string, string | null>>;
  /** The Jira services the write actions run through, as the chat import uses them; throws when Jira is not set up. */
  writeAccess(): Promise<{ ticketService: TicketService; client: IJiraClient }>;
  /** The folder the accepted list lives in. */
  workspaceRoot(): string | undefined;
  now(): number;
  /** The separator the overview CSV uses, from the same setting as every other overview export. */
  csvDelimiter?(): string;
  onDiag?: DiagLogger;
}

/** What the export reads from Jira with the review. */
export interface ImportExportData {
  tickets: OverviewTicket[];
  /** Why the tickets could not be read; the export then refuses. */
  ticketsProblem?: string;
  versions: ProjectVersionInfo[];
  /** The release dates could not be read, so nothing is flagged as due before its release. */
  versionsFailed: boolean;
  /** The descriptions of the stale tickets, whose detail the report does not hold. */
  descriptions: Record<string, string | null>;
}

export interface ImportData {
  reportFileName: string;
  /** The engine's review: every row, the stale tickets, the matched tickets' summaries. */
  review: ReviewSession<ImportRow>;
  /** Each row's dedup keys, by row id. */
  rowKeys: Record<string, string[]>;
  /** Jira's `updated` time of each ticket the tabs show, by key; a ticket missing here was not read. */
  updated: Record<string, string>;
  /** The accepted list (Waltz); null for a kind without one. */
  accepted: { entries: AcceptedEntry[]; warning: string | null } | null;
  /** The stale search failed: the Stale tab is not available. */
  staleFailed: boolean;
  /** How many target descriptions could not be read; those rows get no date comparison. */
  descriptionsUnread: number;
  notices: string[];
  export: ImportExportData;
  baseUrl?: string;
}

/** The report file is not where the recipe says: the stored reading stays on show and nothing is written until it is picked again. */
export class ReportNotFoundError extends Error {
  readonly boardErrorCode = 'report-not-found';
  constructor(readonly reportPath: string) {
    super(`The report file ${reportPath} is not there any more. Pick the file again; nothing is applied until it is found.`);
  }
}

/** The dedup search failed in whole or in part: a reading from it could show items as New that already have tickets. */
export class DedupFailedError extends Error {
  constructor() {
    super('The search for already-ticketed findings failed, so the board keeps what it showed. Refresh once Jira answers again.');
  }
}

function hash(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 32);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

/** The row key of a row: its dedup keys, sorted. Choices and slices are keyed by it, never by row id. */
export function rowKeyOf(data: ImportData, row: ImportRow): string {
  return [...(data.rowKeys[row.id] ?? [row.id])].sort().join('\n');
}

export function newRows(data: ImportData): ImportRow[] {
  return data.review.allRows.filter(r => r.existingTicketKey === null);
}

export function ticketedRows(data: ImportData): ImportRow[] {
  return data.review.allRows.filter(r => r.existingTicketKey !== null);
}

/** Every stale ticket, eligible ones first, as the Stale tab lists them. */
export function staleTickets(data: ImportData): Array<{ key: string; summary: string; status: string; issueType: string; note?: string }> {
  const stale = data.review.staleTickets;
  if (!stale) return [];
  return [
    ...stale.groups.flatMap(g => g.tickets.map(t => ({ key: t.key, summary: t.summary, status: t.currentStatus, issueType: g.issueType }))),
    ...stale.ineligible.map(t => ({ key: t.key, summary: t.summary, status: t.currentStatus, issueType: '', note: t.note })),
  ];
}

/** A row's content apart from its id and the review's own choice fields. */
function rowSignature(row: ImportRow): string {
  const { id: _id, included: _included, memberIds: _members, result: _result, ...content } = row;
  return hash(JSON.stringify(content));
}

/** One tab's slice: what the tab shows, by row key or ticket key, with the ticket it is about and that ticket's `updated`. */
export type SliceEntry = { sig: string; ticket?: string; updated?: string };
export type Slices = Record<ImportTab, Map<string, SliceEntry>>;

export function slicesOf(data: ImportData): Slices {
  const entry = (row: ImportRow): SliceEntry => {
    const ticket = row.target?.key ?? row.existingTicketKey ?? undefined;
    return { sig: rowSignature(row), ...(ticket ? { ticket } : {}), ...(ticket && data.updated[ticket] ? { updated: data.updated[ticket] } : {}) };
  };
  return {
    new: new Map(newRows(data).map(r => [rowKeyOf(data, r), entry(r)])),
    ticketed: new Map(ticketedRows(data).map(r => [rowKeyOf(data, r), entry(r)])),
    stale: new Map(staleTickets(data).map(t => [t.key, {
      sig: hash(JSON.stringify(t)), ticket: t.key, ...(data.updated[t.key] ? { updated: data.updated[t.key] } : {}),
    }])),
    accepted: new Map(data.accepted ? [['list', { sig: hash(JSON.stringify(data.accepted)) }]] : []),
  };
}

export function sliceFingerprint(slice: Map<string, SliceEntry>): string {
  return hash(JSON.stringify([...slice.entries()].sort(([a], [b]) => a.localeCompare(b))));
}

/** The fingerprints of a reading: the report file, the accepted list and each tab's slice. */
export function fingerprintsOf(data: ImportData, report: string, accepted: string): Record<string, string> {
  const slices = slicesOf(data);
  return {
    report, accepted,
    ...Object.fromEntries((Object.keys(slices) as ImportTab[]).map(tab => [`tab:${tab}`, sliceFingerprint(slices[tab])])),
  };
}

/** The accepted list's fingerprint, so a later check knows whether the file changed and an accept knows its own write. */
export function acceptedFingerprint(root: string | undefined): string {
  if (!root) return 'none';
  try {
    return hash(fs.readFileSync(path.join(root, ACCEPTED_FILE_NAME)));
  } catch {
    return 'none';
  }
}

async function readWith<TItem, TRow extends ReviewRowBase & ImportRow>(
  recipe: ImportRecipe, descriptor: ReportImportDescriptor<TItem, TRow>, deps: ImportDeps,
): Promise<DerivedPart<ImportData>> {
  let bytes: Buffer;
  try {
    bytes = await fs.promises.readFile(recipe.reportPath);
  } catch (err) {
    if (isMissing(err)) throw new ReportNotFoundError(recipe.reportPath);
    throw new Error(`The report file ${recipe.reportPath} cannot be read: ${messageOf(err)}`);
  }
  let parsed: { items: TItem[]; rawItems: unknown[] };
  try {
    parsed = await descriptor.parseAndFilter!(recipe.reportPath);
  } catch (err) {
    if (isMissing(err)) throw new ReportNotFoundError(recipe.reportPath);
    throw new Error(`The report file ${path.basename(recipe.reportPath)} cannot be read: ${messageOf(err)}`);
  }

  const notices: string[] = [];
  const template = await deps.templateFields(recipe, descriptor);
  if (template.problem) notices.push(template.problem);

  let staleFailed = false;
  let descriptionsUnread = 0;
  const { session, dedupFailed } = await deps.buildReview({
    projectKey: recipe.projectKey, items: parsed.items, rawItems: parsed.rawItems, reportFilePath: recipe.reportPath,
    issueType: recipe.issueType, templateName: recipe.templateName, additionalFields: template.additionalFields,
  }, descriptor, event => {
    if (event.kind === 'stale-failed') staleFailed = true;
    else if (event.kind === 'descriptions-unread') descriptionsUnread = event.failed;
    else if (event.kind === 'stale-truncated') notices.push(`Only the first ${event.checked} of ${event.totalFound} ticket(s) carrying the stale-check label were checked, so Stale may be incomplete.`);
    else if (event.kind === 'accepted-warning') notices.push(event.warning);
  });
  if (dedupFailed) throw new DedupFailedError();

  const review = session as unknown as ReviewSession<ImportRow>;
  const rowKeys: Record<string, string[]> = {};
  for (const row of session.allRows) rowKeys[row.id] = descriptor.dedupKeyOf!(descriptor.fold!.itemOf(row));

  let accepted: ImportData['accepted'] = null;
  if (descriptor.accepted) {
    const loaded = descriptor.accepted.service()?.load();
    accepted = { entries: loaded?.entries ?? [], warning: loaded?.warning ?? null };
  }

  // What the export lists: the open targets of the matched rows and the stale tickets.
  const data: ImportData = {
    reportFileName: path.basename(recipe.reportPath), review, rowKeys, updated: {}, accepted, staleFailed, descriptionsUnread, notices,
    export: { tickets: [], versions: [], versionsFailed: false, descriptions: {} },
  };
  const tracked = [...new Set(ticketedRows(data).flatMap(r => (r.target && !r.target.resolved ? [r.target.key] : [])))];
  const stale = staleTickets(data).map(t => t.key);
  const shown = [...new Set([...ticketedRows(data).map(r => r.target?.key ?? r.existingTicketKey!), ...stale])];
  const source = descriptor.overviewExport?.source ?? (recipe.kind === 'waltz' ? 'waltz' : 'veracode');
  const exportKeys = [...new Set([...tracked, ...stale])];
  if (exportKeys.length > 0) {
    try {
      data.export.tickets = await deps.overviewTickets(exportKeys, source);
    } catch (err) {
      data.export.ticketsProblem = messageOf(err);
    }
  }
  try {
    data.export.versions = await deps.projectVersions(recipe.projectKey);
  } catch (err) {
    data.export.versionsFailed = true;
    deps.onDiag?.('warn', 'Import board: the project versions could not be read', { projectKey: recipe.projectKey, error: messageOf(err) });
  }
  const staleOnly = stale.filter(key => !tracked.includes(key));
  if (staleOnly.length > 0) data.export.descriptions = await deps.descriptions(staleOnly);
  if (shown.length > 0) {
    try {
      data.updated = await deps.updatedTimes(shown);
    } catch (err) {
      // Without `updated` a later check compares the rows' content only.
      deps.onDiag?.('warn', 'Import board: the tickets\' update times could not be read', { error: messageOf(err) });
    }
  }
  data.baseUrl = await deps.baseUrl();

  return { readAt: deps.now(), fingerprints: fingerprintsOf(data, hash(bytes), acceptedFingerprint(deps.workspaceRoot())), data };
}

/** Reads the report and Jira for an import. A missing report file and a failed dedup search throw; a failed stale search does not. */
export async function readImport(recipe: ImportRecipe, deps: ImportDeps): Promise<DerivedPart<ImportData>> {
  const descriptors = deps.descriptors();
  return recipe.kind === 'waltz'
    ? readWith(recipe, descriptors.waltz as ReportImportDescriptor<WaltzComponent[], WaltzReviewRow & ImportRow>, deps)
    : readWith(recipe, descriptors.veracode as ReportImportDescriptor<VeracodeFlaw[], VeracodeReviewRow & ImportRow>, deps);
}
