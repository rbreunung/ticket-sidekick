// Types of the report-import flow: the per-importer `ReportImportDescriptor` and its optional capabilities
// (accepted list, finding folding, change tracking). Type-only; see reportImportHandler.ts for the flow.
import type { TicketService } from '../../services/TicketService';
import type { AcceptedListService } from '../../services/AcceptedListService';
import type { AcceptedEntry } from '../../utils/waltzAccepted';
import type { RowChange } from '../../utils/reportImport';
import type { ReviewRowBase, ReviewTableColumn } from '../sessionState';

export interface ReportImportRow extends ReviewRowBase {
  labels: string[];
  summary: string;
  descriptionWiki: string;
}

/**
 * Per-importer descriptor (KTD3) — a plain object of typed fields/functions, not a class hierarchy
 * or a registry. Everything genuinely different between an importer lives here; everything about
 * the session flow itself (control flow AND message wording, per KTD1) lives in the functions below
 * and must not be overridable through this object. `TRow` need only satisfy `ReviewRowBase` — the
 * dedup-shaped `ReportImportRow` fields (labels/summary/descriptionWiki) are Veracode/Waltz-specific,
 * not a shared-row requirement, so an importer with no dedup concept (email) can supply its own row
 * shape instead.
 */
export interface ReportImportDescriptor<TItem, TRow extends ReviewRowBase> {
  // R6/KTD4: identifies which importer this is to the shared issue-type chat-ask's
  // AwaitIssueTypeResume — JiraParticipant.ts's router uses it to pick which of
  // veracodeHandler.ts's/waltzHandler.ts's/emailHandler.ts's handleXAwaitIssueType wrapper to
  // resume through.
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
  // readAndFilterXFile — encoding-aware per importer. U6: also returns the *raw, unfiltered* parsed
  // items (`rawItems`) alongside the filtered `items` — needed by `descriptor.stale.buildActivePredicate`
  // below. `unknown[]` rather than a second generic parameter: Veracode's raw items (individual
  // pre-fold flaws) are a different shape than `TItem` (folded groups) — see ImportTemplateSelectionSession.rawItems.
  parseAndFilter?: (filePath: string) => Promise<{ items: TItem[]; rawItems: unknown[] }>;
  sessionKeys: {
    templateSelection: string;
    review: string;
  };
  // KTD2: dedup is optional — an importer with no dedup key (email) omits all three, and the
  // "already ticketed" search step is skipped entirely instead of run and found empty.
  // U2/R11: both return one candidate value *per member* of the item — a folded Veracode group
  // returns one label/key per flaw it contains and a Waltz group one per component, so a
  // match on any one of them counts as already-ticketed.
  searchLabelOf?: (item: TItem) => string[]; // every label value searched for in the dedup JQL
  dedupKeyOf?: (item: TItem) => string[]; // every key looked up in the dedup map (may differ from searchLabelOf)
  labelToDedupKey?: (label: string) => string | null;
  buildRowFields: (item: TItem, templateLabels: string[]) => Omit<TRow, keyof ReviewRowBase>;
  reviewColumns: ReviewTableColumn<TRow>[];
  itemRefFor: (row: TRow) => string; // e.g. 'Flaw 10101' / 'example-lib:1.2.3' — creation-failure line + log details
  // KTD3: builds the ticket's summary + create-fields from a row (and the batch's resolved template
  // fields) — the only place a row's fields become a `createTicket()` call, so an importer with no
  // `labels`/`descriptionWiki` concept (email) never needs those fields at all.
  buildTicketFields: (row: TRow, additionalFields: Record<string, unknown>) => { summary: string; fields: Record<string, unknown> };
  // KTD4: optional per-row work after a ticket is created (email uses this for attachment upload).
  // A rejection is caught by the shared creation step (createOne) and shown as a warning — it never fails the row,
  // since the ticket already exists by the time this runs.
  afterCreate?: (row: TRow, issueKey: string, ticketService: TicketService) => Promise<void>;
  // KTD9: optional UI-notify callback for issue-type-fetch failure, so Veracode's user-visible
  // showWarningMessage on that path survives being driven through this shared builder. Waltz/email
  // omit it (or could pass a log-only callback) since they have no such warning today.
  onIssueTypeFetchFailed?: (message: string, projectKey: string) => void;
  // U6: optional reverse stale-ticket check (findStaleTickets, R1/R5) — an importer with no
  // marker-label concept (email) omits this and the stale section/ask never runs for it.
  // `buildActivePredicate` receives the batch's raw, unfiltered items (see
  // ImportTemplateSelectionSession.rawItems) and returns the "is this marker id still active"
  // predicate findStaleTickets() needs; the importer's own handler file (veracodeHandler.ts/
  // waltzHandler.ts) casts `rawItems` back to its real type before delegating to
  // buildVeracodeActiveFlawPredicate/buildWaltzActiveComponentPredicate.
  stale?: {
    markerLabel: string;
    labelToDedupKey: (label: string) => string | null;
    buildActivePredicate: (rawItems: unknown[]) => (dedupKey: string) => boolean;
  };
  // Import ticket updates parity (KTD2): optional change tracking for already-ticketed rows —
  // drives the per-row actions (update / follow-up / re-create / leave) on the Already-ticketed
  // screen. Veracode and Waltz configure it; email (no dedup, no Already-ticketed group) omits it.
  // Without it an already-ticketed row only offers re-create / leave.
  changeTracking?: ImportChangeTracking<TItem, TRow>;
  // Finding folding (KTD4): optional merge/unmerge/add support. An importer that omits it (email)
  // offers none of those replies. Both Veracode and Waltz items are groups, so combining items is
  // concatenation (KTD1).
  fold?: ImportFold<TItem, TRow>;
  // Accepted-CVE list (KTD8): optional, like `fold` and `stale`. Waltz supplies it; Veracode and email
  // omit it and behave exactly as before.
  accepted?: ImportAccepted<TItem, TRow>;
}

/** Accepted-CVE list: what an importer supplies so findings the team accepted stay off the New screen. */
export interface ImportAccepted<TItem, TRow extends ReviewRowBase> {
  /** The row's group of findings or components. */
  itemOf: (row: TRow) => TItem;
  /** The list's file service, or null when no workspace folder is open (nothing hidden, nothing writable). */
  service: () => AcceptedListService | null;
  /** The item with accepted findings taken out and its rating recomputed; `item` is null when nothing of it is left. */
  narrow: (item: TItem, entries: AcceptedEntry[]) => { item: TItem | null; hiddenCves: number; belowFloor: number };
  /** One entry per finding the item currently lists, each carrying the reason when given — what `accept` writes for a row. */
  entriesOf: (item: TItem, reason?: string) => AcceptedEntry[];
}

/** Finding folding (KTD1/KTD4): what an importer supplies so its New rows can be merged by the user. */
export interface ImportFold<TItem, TRow extends ReviewRowBase> {
  /** The row's group of findings or components. */
  itemOf: (row: TRow) => TItem;
  /** One item holding every member of `items`, in order. */
  combine: (items: TItem[]) => TItem;
  /** The record labels an `add` writes to the target ticket (no template labels: a foreign ticket is not ours to label). */
  recordLabelsOf: (item: TItem) => string[];
  /** The comment an `add` posts: the added item in the folded layout, plus findings a rewrite no longer covers. */
  buildComment: (item: TItem, droppedKeys: string[]) => string;
  /**
   * Optional: narrows a row's item to the findings its ticket did not record yet, for a rewrite's
   * traceability comment (Veracode keeps only the new flaws). Without it the whole item is listed.
   */
  narrowToNew?: (item: TItem, change: FindingsChange) => TItem;
}

type FindingsChange = Extract<RowChange, { kind: 'findings' }>;

/** Import ticket updates parity (KTD2): what an importer supplies so already-ticketed rows can be updated. */
export interface ImportChangeTracking<TItem, TRow extends ReviewRowBase> {
  /** What one finding is called in the Change column, e.g. 'flaw(s)' / 'CVE(s)'. */
  findingNoun: string;
  /** R1/R2/R4: what changed on an item, given the union of labels across all of its tickets; null = no change. */
  describe: (item: TItem, knownLabels: string[]) => RowChange | null;
  /** The record labels `update` adds to the target ticket: all of them for a baseline, only the new ones otherwise. */
  recordLabelsOf: (row: TRow, change: RowChange) => string[];
  /** KTD3: labels with this prefix are replaced, not accumulated, whenever `update` adds one (Waltz: `oss-rating-`). */
  removeLabelPrefix?: string;
  /** R11/R12: the one comment `update` posts — Markdown converted to Jira wiki markup, every report value sanitized. */
  buildUpdateComment: (row: TRow, change: FindingsChange, options: { summaryUnchanged: boolean }) => string;
  /**
   * R12: the ticket's new summary for this change, `null` when this summary cannot be rewritten (the
   * user renamed it — the comment then says so), or `undefined` when no rewrite applies.
   */
  rewriteSummary?: (summary: string, change: FindingsChange) => string | null | undefined;
  /** R14/KTD10: the follow-up ticket's summary and create-fields, covering only the new findings. */
  buildFollowUp: (
    row: TRow, change: FindingsChange, originalKey: string, additionalFields: Record<string, unknown>,
  ) => { summary: string; fields: Record<string, unknown> };
}
