// Types of the report-import flow: the per-importer `ReportImportDescriptor` and its optional capabilities
// (accepted list, finding folding, change tracking). Type-only and vscode-free.
import type { TicketService } from '../services/TicketService';
import type { AcceptedListService } from '../services/AcceptedListService';
import type { AcceptedEntry } from '../utils/waltzAccepted';
import type { ChangeContext, CommentDetails, RowChange, TicketedActionChoice } from '../utils/reportImport';
import type { TicketFinding } from '../utils/veracodeFindingsTable';
import type { TicketComponent } from '../utils/waltzComponentsTable';
import type { ReviewTableColumn } from '../utils/chatPrimitives';
import type { DiagLogger } from '../utils/diagTypes';
import type { ActionLabels, ReviewRowBase } from './types';

export interface ReportImportRow extends ReviewRowBase {
  labels: string[];
  summary: string;
  descriptionWiki: string;
}

/**
 * Per-importer descriptor — a plain object of typed fields/functions, not a class hierarchy
 * or a registry. Everything genuinely different between an importer lives here; everything about
 * the session flow itself (control flow AND message wording) lives in the functions below
 * and must not be overridable through this object. `TRow` need only satisfy `ReviewRowBase` — the
 * dedup-shaped `ReportImportRow` fields (labels/summary/descriptionWiki) are Veracode/Waltz-specific,
 * not a shared-row requirement, so an importer with no dedup concept (email) can supply its own row
 * shape instead.
 */
export interface ReportImportDescriptor<TItem, TRow extends ReviewRowBase> {
  // Identifies which importer this is. The shared issue-type chat-ask's AwaitIssueTypeResume
  // carries it, and JiraParticipant.ts's router resumes only an 'email' one, through
  // emailHandler.ts's handleEmailAwaitIssueType; the import board picks the Veracode or Waltz
  // descriptor by its recipe's kind.
  descriptorKind: 'veracode' | 'waltz' | 'email';
  scope: string; // logDiag scope, e.g. 'jira.veracode' / 'jira.waltz' / 'jira.email'
  importLabel: string; // e.g. 'Veracode' / 'Waltz OSS' — used only in the final diag-log line
  itemNoun: string; // e.g. 'flaw(s)' / 'component(s)' — table/summary wording
  filterKindLabel: string; // e.g. 'severity/status' / 'rating/remediation' — template-selection wording
  noMatchMessage: string; // full "no items matched your filters" message (config key names differ per importer)
  // These three back openReportFilePicker()/handleImportReport() below, which are single-file (one
  // report -> many items) — Veracode/Waltz's only file-picker entry point. Optional because email's
  // one-file-per-item shape doesn't fit that contract; email's own entry points (emailHandler.ts)
  // build EmailImportItem[] themselves via a multi-select picker and call buildImportTemplateSession()
  // directly, bypassing openReportFilePicker()/handleImportReport() entirely — so email's descriptor
  // omits all three rather than supplying values nothing would ever invoke.
  fileFilter?: { label: string; extensions: string[] };
  filePickerTitle?: string;
  // readAndFilterXFile — encoding-aware per importer. Also returns the *raw, unfiltered* parsed
  // items (`rawItems`) alongside the filtered `items` — needed by `descriptor.stale.buildActivePredicate`
  // below. `unknown[]` rather than a second generic parameter: Veracode's raw items (individual
  // pre-fold flaws) are a different shape than `TItem` (folded groups) — see ImportTemplateSelectionSession.rawItems.
  parseAndFilter?: (filePath: string) => Promise<{ items: TItem[]; rawItems: unknown[] }>;
  sessionKeys: {
    templateSelection: string;
    review: string;
  };
  // Dedup is optional — an importer with no dedup key (email) omits all three, and the
  // "already ticketed" search step is skipped entirely instead of run and found empty.
  // Both return one candidate value *per member* of the item — a folded Veracode group
  // returns one label/key per flaw it contains and a Waltz group one per component, so a
  // match on any one of them counts as already-ticketed.
  searchLabelOf?: (item: TItem) => string[]; // every label value searched for in the dedup JQL
  dedupKeyOf?: (item: TItem) => string[]; // every key looked up in the dedup map (may differ from searchLabelOf)
  labelToDedupKey?: (label: string) => string | null;
  buildRowFields: (item: TItem, templateLabels: string[]) => Omit<TRow, keyof ReviewRowBase>;
  reviewColumns: ReviewTableColumn<TRow>[];
  itemRefFor: (row: TRow) => string; // e.g. 'Flaw 10101' / 'example-lib:1.2.3' — creation-failure line + log details
  // Builds the ticket's summary + create-fields from a row (and the batch's resolved template
  // fields) — the only place a row's fields become a `createTicket()` call, so an importer with no
  // `labels`/`descriptionWiki` concept (email) never needs those fields at all.
  buildTicketFields: (row: TRow, additionalFields: Record<string, unknown>, context?: TicketWriteContext) => BuiltTicketFields;
  // Optional per-row work after a ticket is created (email uses this for attachment upload).
  // A rejection is caught by the shared creation step (createOne) and shown as a warning — it never fails the row,
  // since the ticket already exists by the time this runs.
  afterCreate?: (row: TRow, issueKey: string, ticketService: TicketService) => Promise<void>;
  // Optional UI-notify callback for issue-type-fetch failure, so Veracode's user-visible
  // showWarningMessage on that path survives being driven through this shared builder. Waltz/email
  // omit it (or could pass a log-only callback) since they have no such warning today.
  onIssueTypeFetchFailed?: (message: string, projectKey: string) => void;
  // Optional reverse stale-ticket check (findStaleTickets) — an importer with no
  // marker-label concept (email) omits this and the stale section/ask never runs for it.
  // `buildActivePredicate` receives the batch's raw, unfiltered items (see
  // ImportTemplateSelectionSession.rawItems) and returns the "is this marker id still active"
  // predicate findStaleTickets() needs; the importer's own descriptor (src/imports/veracode.ts /
  // src/imports/waltz.ts) casts `rawItems` back to its real type before delegating to
  // buildVeracodeActiveFlawPredicate/buildWaltzActiveComponentPredicate.
  stale?: {
    markerLabel: string;
    labelToDedupKey: (label: string) => string | null;
    buildActivePredicate: (rawItems: unknown[], acceptedEntries: AcceptedEntry[]) => (dedupKey: string) => boolean;
  };
  // Import ticket updates parity: optional change tracking for already-ticketed rows —
  // drives the per-row actions (update / follow-up / re-create / leave) on the Already-ticketed
  // screen. Veracode and Waltz configure it; email (no dedup, no Already-ticketed group) omits it.
  // Without it an already-ticketed row only offers re-create / leave.
  changeTracking?: ImportChangeTracking<TItem, TRow>;
  // Finding folding: optional merge/unmerge/add support. An importer that omits it (email)
  // offers none of those replies. Both Veracode and Waltz items are groups, so combining items is
  // concatenation.
  fold?: ImportFold<TItem, TRow>;
  // Accepted-CVE list: optional, like `fold` and `stale`. Waltz supplies it; Veracode and email
  // omit it and behave exactly as before.
  accepted?: ImportAccepted<TItem, TRow>;
  // Ticket merge: optional `merge … into …`, `reload report` and the refresh after an `unaccept`.
  // Waltz supplies it in rewrite mode, Veracode in close mode; email omits it and behaves exactly as before.
  ticketMerge?: ImportTicketMerge;
  // Security overview export: optional `export` reply that lists this report's items by Fix Version. Veracode and Waltz
  // supply it; email omits it and has no `export` reply.
  overviewExport?: ImportOverviewExport<TRow>;
  /**
   * The Due Date a rewrite writes: Veracode sets it once and a later import only moves it earlier, Waltz overwrites it
   * with the regenerated group's date. Returns the date to write, or null to leave the ticket's own alone. Without
   * it a rewrite writes no Due Date (email).
   */
  rewriteDueDate?: (params: {
    regenItem: TItem; joiningItem: TItem | null; currentDueDate: string | null; ticketCreated: string | null;
  }) => string | null;
  /** The result-line note after a rewrite wrote this Due Date; without it the line says only that the date was set. */
  dueDateNote?: (dueDate: string) => string;
}

/** What a ticket write knows about the ticket beyond the row: an existing ticket's creation time (a rewrite), absent for a new ticket. */
export interface TicketWriteContext {
  ticketCreated?: string | null;
}

/** What an importer supplies so the `export` reply can list a row's report-side detail. */
export interface ImportOverviewExport<TRow extends ReviewRowBase> {
  source: 'veracode' | 'waltz';
  /** The row's report items as records (exact: they come straight from the parsed report). */
  detailOf: (row: TRow) => { findings?: TicketFinding[]; components?: TicketComponent[] };
  /** The row's one-line description for the overview. */
  summaryOf: (row: TRow) => string;
  /** The Due Date the report implies for the row, null when it has none. */
  dueDateOf: (row: TRow) => string | null;
}

/**
 * Ticket merge (`merge … into …`). Rewrite mode (Waltz, the default) rewrites the kept ticket, comments on it and marks each
 * closed ticket with a banner; close mode (Veracode) moves items across only when the kept ticket lacks them, then links,
 * comments on and closes each source without editing its text.
 */
export interface RewriteTicketMerge {
  mode?: 'rewrite';
  /** Opens the survivor's comment (Jira wiki markup), naming the tickets it absorbed. */
  buildCommentPreface: (absorbedKeys: string[]) => string;
}

export interface CloseTicketMerge {
  mode: 'close';
  /** One item in the importer's words for the confirmation page, e.g. `flaw`. */
  itemNoun: string;
  /**
   * The comment on a closed source (Jira wiki markup): `preface` is its opening line, `unlistedKeys` the items the report
   * no longer lists and `elsewhereKeys` the ones it still lists outside the rebuilt ticket.
   */
  buildSourceComment: (survivorKey: string, unlistedKeys: string[], elsewhereKeys: string[]) => { preface: string; text: string };
}

export type ImportTicketMerge = RewriteTicketMerge | CloseTicketMerge;

/** Accepted-CVE list: what an importer supplies so findings the team accepted stay off the New screen. */
export interface ImportAccepted<TItem, TRow extends ReviewRowBase> {
  /** The row's group of findings or components. */
  itemOf: (row: TRow) => TItem;
  /** The list's file service, or null when no workspace folder is open (nothing hidden, nothing writable). */
  service: () => AcceptedListService | null;
  /** The item with accepted findings taken out and its rating recomputed; `item` is null when nothing of it is left. */
  narrow: (item: TItem, entries: AcceptedEntry[]) => { item: TItem | null; hiddenCves: number; belowFloor: number; hiddenComponents: number };
  /** True when every component of an already-ticketed item is accepted as a whole, so its row is dropped from Already ticketed. */
  isAccepted: (item: TItem, entries: AcceptedEntry[]) => boolean;
  /** One entry per component + version the item lists, each carrying the reason when given — what `accept component` writes for a row. */
  componentEntriesOf: (item: TItem, reason?: string) => AcceptedEntry[];
  /** One entry per finding the item currently lists, each carrying the reason when given — what `accept` writes for a row. */
  entriesOf: (item: TItem, reason?: string) => AcceptedEntry[];
}

/** Finding folding: what an importer supplies so its New rows can be merged by the user. */
export interface ImportFold<TItem, TRow extends ReviewRowBase> {
  /** The row's group of findings or components. */
  itemOf: (row: TRow) => TItem;
  /** One item holding every member of `items`, in order. */
  combine: (items: TItem[]) => TItem;
  /** The record labels an `add` writes to the target ticket (no template labels: a foreign ticket is not ours to label). */
  recordLabelsOf: (item: TItem) => string[];
  /** The comment an `add` posts: the added item in the folded layout, plus findings a rewrite no longer covers. */
  buildComment: (item: TItem, droppedKeys: string[], details?: CommentDetails) => string;
  /**
   * Optional: narrows a row's item to the findings its ticket did not record yet, for a rewrite's
   * traceability comment (Veracode keeps only the new flaws). Without it the whole item is listed.
   */
  narrowToNew?: (item: TItem, change: FindingsChange) => TItem;
}

type FindingsChange = Extract<RowChange, { kind: 'findings' }>;

/**
 * A ticket's summary and create-fields. `optionalFields` names fields of `fields` that Jira may refuse
 * (the Waltz Due Date, missing from a project's screen): a 400 naming one repeats the write without it.
 */
export interface BuiltTicketFields {
  summary: string;
  fields: Record<string, unknown>;
  optionalFields?: string[];
}

/** Import ticket updates parity: what an importer supplies so already-ticketed rows can be updated. */
export interface ImportChangeTracking<TItem, TRow extends ReviewRowBase> {
  /** What one finding is called in the Change column, e.g. 'flaw(s)' / 'CVE(s)'. */
  findingNoun: string;
  /** What changed on an item, given the union of labels across all of its tickets; null = no change. */
  describe: (item: TItem, knownLabels: string[], context?: ChangeContext) => RowChange | null;
  /**
   * The importer's own Already-ticketed action policy in place of the shared five-action one (Waltz and Veracode:
   * `rewrite`, `leave` and `new ticket`). Its presence also switches on a full-ticket `new ticket` (which needs no new
   * findings) and the shared `rewrite` default for rows that point to one ticket.
   */
  deriveActions?: (change: RowChange | null, anyOpen: boolean) => TicketedActionChoice;
  /**
   * With `deriveActions`: read each target ticket's description to compare what it recorded with the report, and run the
   * dropped-member pass (Waltz). Veracode does not need either, so it leaves this off.
   */
  readsTargetDescriptions?: boolean;
  /**
   * Veracode: an open target ticket with an empty Due Date counts as changed for dates when `expectedFor` gives the row's item
   * a due date (it gets the target's Jira creation timestamp to date an undated finding). Needs `deriveActions`.
   */
  dueDateBackfill?: { expectedFor: (item: TItem, ticketCreated: string | null) => string | null };
  /** The importer's own words for row actions, by action id (Waltz shows `follow-up` as `new ticket`). */
  actionLabels?: ActionLabels;
  /** With `readsTargetDescriptions`: the dedup keys of every component in the unfiltered report, so a component only filtered or accepted away is not "dropped". */
  reportKeysOf?: (rawItems: unknown[]) => string[];
  /** The record labels `update` adds to the target ticket: all of them for a baseline, only the new ones otherwise. Omitted by an importer whose policy never offers `update`. */
  recordLabelsOf?: (row: TRow, change: RowChange) => string[];
  /** Labels with this prefix are replaced, not accumulated, whenever `update` adds one (Waltz: `oss-rating-`). */
  removeLabelPrefix?: string;
  /** The one comment `update` posts — Markdown converted to Jira wiki markup, every report value sanitized. */
  buildUpdateComment?: (row: TRow, change: FindingsChange, options: { summaryUnchanged: boolean }) => string;
  /**
   * The ticket's new summary for this change, `null` when this summary cannot be rewritten (the
   * user renamed it — the comment then says so), or `undefined` when no rewrite applies.
   */
  rewriteSummary?: (summary: string, change: FindingsChange) => string | null | undefined;
  /** The follow-up ticket's summary and create-fields, covering only the new findings. */
  buildFollowUp: (
    row: TRow, change: FindingsChange, originalKey: string, additionalFields: Record<string, unknown>,
  ) => BuiltTicketFields;
}

/** What the caller of an importer's descriptor factory supplies: the review columns, the issue-type warning, and the importer's log. */
export interface ImportDescriptorHost<TRow extends ReviewRowBase> {
  reviewColumns: ReviewTableColumn<TRow>[];
  onIssueTypeFetchFailed?: (message: string, projectKey: string) => void;
  onDiag?: DiagLogger;
}
