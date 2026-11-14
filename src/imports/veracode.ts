// The Veracode report importer: reading and folding a Detailed Report, its labels and stale-check predicate, the SLA Due
// Date, and the descriptor the shared import flow runs on. vscode-free: the settings are passed in as readers.
import * as fs from 'fs';
import type { DiagLogger } from '../utils/diagTypes';
import {
  parseVeracodeReport, filterFlaws, severityLabel, groupFlawsByLocation,
  buildGroupSummary, buildGroupDescriptionWiki, buildGroupLabels, buildFoldedCommentWiki,
  describeVeracodeChange, flawsWithIds, buildFollowUpSummary, buildMergedSourceComment,
  type VeracodeFlaw, type VeracodeReviewRow,
} from '../utils/veracodeReport';
import { templateLabelsOf, deriveRewriteActions } from '../utils/reportImport';
import { findingFromFlaw, localDate } from '../utils/securityOverview';
import { resolveSlaDays, groupDueDate, SLA_SEVERITY_NAMES, type DueContext } from '../utils/veracodeDates';
import { toCalendarDate } from '../utils/calendarDate';
import type { ImportDescriptorHost, ReportImportDescriptor } from './descriptor';
import { readAndFilterReport } from './review';

/** The Veracode settings, read each time they are needed. */
export interface VeracodeSettings {
  /** `minSeverity`, `includeRemediationStatuses` and the resolved `maxReportSizeMB` in bytes. */
  filter: () => { minSeverity: number; includeStatuses: string[]; maxReportBytes: number };
  /** The raw `ticketSidekick.veracode.slaDays` value. */
  slaDays: () => unknown;
}

/**
 * The SLA day counts and the start for a flaw with no first-found date: the existing ticket's creation date when one is
 * being rewritten, else the import date.
 */
function veracodeDue(settings: VeracodeSettings, ticketCreated?: string | null): DueContext {
  return { days: resolveSlaDays(settings.slaDays()).days, fallbackStart: toCalendarDate(ticketCreated) ?? localDate() };
}

/** A group's due date under the SLA table, counting a flaw with no first-found date from `ticketCreated` (else today). */
function veracodeGroupDue(settings: VeracodeSettings, group: VeracodeFlaw[], ticketCreated?: string | null): string | null {
  return groupDueDate(group, veracodeDue(settings, ticketCreated));
}

// A problem with the setting is logged once per import, when its session is built, never once per row.
export function logVeracodeSlaProblems(settings: VeracodeSettings, onDiag?: DiagLogger): void {
  const { unknownKeys, invalidKeys } = resolveSlaDays(settings.slaDays());
  if (unknownKeys.length === 0 && invalidKeys.length === 0) return;
  onDiag?.('warn', 'ticketSidekick.veracode.slaDays has entries that were ignored', {
    unknownKeys, invalidKeys, validNames: [...SLA_SEVERITY_NAMES],
  });
}

// U2: folds immediately after parse+filter — before dedup ever runs (KTD1) — so every downstream
// step (dedup search, review-row building, ticket creation) operates on folded groups
// (VeracodeFlaw[], one or more flaws sharing a source file + line, R9) rather than individual
// flaws. A flaw with no location (missing sourceFile/line) never folds with anything and comes
// back as its own singleton group — see groupFlawsByLocation()'s own doc comment.
async function readAndFilterVeracodeFile(filePath: string, settings: VeracodeSettings, onDiag?: DiagLogger): Promise<{ items: VeracodeFlaw[][]; rawItems: VeracodeFlaw[] }> {
  // parseVeracodeReport() itself also re-checks size + rejects DOCTYPE/ENTITY (defense in depth,
  // and it's the single source of truth used by the pure unit tests too) — both checks share the
  // same resolved maxReportBytes so they agree with each other and with the user's setting.
  logVeracodeSlaProblems(settings, onDiag);
  const { maxReportBytes, ...filterConfig } = settings.filter();
  // U6: buildVeracodeActiveFlawPredicate needs the raw, unfiltered flaws (before
  // minSeverity/includeRemediationStatuses) — readAndFilterReport returns them directly as
  // `rawItems` alongside the filtered/folded set, no closure capture needed.
  const { items: filtered, rawItems: rawFlaws } = await readAndFilterReport(
    filePath,
    fp => fs.promises.readFile(fp, 'utf-8'),
    raw => parseVeracodeReport(raw, maxReportBytes),
    flaws => filterFlaws(flaws, filterConfig),
    maxReportBytes,
  );
  return { items: groupFlawsByLocation(filtered), rawItems: rawFlaws };
}

// U5: the `veracode` label every Veracode-imported ticket carries (alongside its
// `veracode-issue-<id>` marker label(s)) — reportImport.ts's findStaleTickets() searches on this to
// find open tickets whose finding(s) have disappeared from the current report. Not yet wired into
// the chat flow (that's U6); exported here so that later unit can call findStaleTickets() with the
// right marker label without duplicating it.
export const VERACODE_STALE_MARKER_LABEL = 'veracode';

// Extracted so the descriptor's own labelToDedupKey (dedup search) and findStaleTickets()'s
// labelToDedupKey (stale search, U6) parse the identical `veracode-issue-<id>` label shape from one
// implementation instead of two copies that could drift apart.
export function veracodeLabelToIssueId(label: string): string | null {
  const match = label.match(/^veracode-issue-(\d+)$/);
  return match ? match[1] : null;
}

/**
 * Builds the "is this flaw id still active" predicate findStaleTickets() needs (U5's R2/R3). A
 * flaw id is active when it's present in the *raw* parsed report (before the
 * minSeverity/includeRemediationStatuses filter that decides what gets a *new* ticket — R2 says
 * "absent from the raw parsed report") with a remediationStatus that still matches
 * `includeStatuses`. Deliberately ignores minSeverity: R2 only mentions remediation status, so a
 * flaw that dropped below the severity floor but is still open does not make its ticket stale.
 */
export function buildVeracodeActiveFlawPredicate(
  rawFlaws: VeracodeFlaw[],
  includeStatuses: string[],
): (issueId: string) => boolean {
  const statusSet = new Set(includeStatuses.map(s => s.toLowerCase()));
  const statusById = new Map(rawFlaws.map(f => [f.issueId, f.remediationStatus] as const));
  return (issueId: string) => {
    const status = statusById.get(issueId);
    return status !== undefined && statusSet.has(status.toLowerCase());
  };
}

/**
 * The Veracode descriptor. Its settings are read through `settings` each time they are needed, so a changed setting
 * applies to the next step without a restart; `host` supplies what the caller shows (the review columns, the issue-type
 * warning) and where the importer's own log lines go.
 */
export function createVeracodeDescriptor(settings: VeracodeSettings, host: ImportDescriptorHost<VeracodeReviewRow>): ReportImportDescriptor<VeracodeFlaw[], VeracodeReviewRow> {
  const dueContext = (ticketCreated?: string | null) => veracodeDue(settings, ticketCreated);
  const groupDue = (group: VeracodeFlaw[], ticketCreated?: string | null) => veracodeGroupDue(settings, group, ticketCreated);
  return {
    descriptorKind: 'veracode',
    scope: 'jira.veracode',
    importLabel: 'Veracode',
    itemNoun: 'flaw(s)',
    filterKindLabel: 'severity/status',
    noMatchMessage:
      'No flaws in this report matched your current filters ' +
      '(`ticketSidekick.veracode.minSeverity` / `ticketSidekick.veracode.includeRemediationStatuses`).',
    fileFilter: { label: 'Veracode report', extensions: ['xml'] },
    filePickerTitle: 'Select Veracode Detailed Report (.xml)',
    parseAndFilter: filePath => readAndFilterVeracodeFile(filePath, settings, host.onDiag),
    sessionKeys: {
      templateSelection: 'jira.session.veracodeTemplateSelection',
      review: 'jira.session.veracodeReview',
    },
    // U2/R11: one label/key per member flaw in the folded group — a match on any one of them
    // (an already-ticketed single flaw from a prior, unfolded run, say) counts the whole group as
    // already-ticketed.
    searchLabelOf: group => group.map(flaw => `veracode-issue-${flaw.issueId}`),
    dedupKeyOf: group => group.map(flaw => flaw.issueId),
    labelToDedupKey: veracodeLabelToIssueId,
    buildRowFields: (group, templateLabels) => {
      const first = group[0];
      // A fold shows its most severe member (finding folding plan, Assumptions).
      const severity = Math.max(...group.map(flaw => flaw.severity));
      return {
        issueIds: group.map(flaw => flaw.issueId),
        severity,
        severityLabelText: severityLabel(severity),
        cweId: first.cweId,
        summary: buildGroupSummary(group),
        labels: buildGroupLabels(group, templateLabels),
        // U4/R6-R7: no eager buildGroupDescriptionWiki() call here — the group is kept on the row
        // instead, and the full description is built just-in-time in buildTicketFields below, only
        // for a row the user actually confirms into creation.
        sourceGroup: group,
      };
    },
    reviewColumns: host.reviewColumns,
    itemRefFor: row => `Flaw ${row.issueIds.join(', ')}`,
    // The Due Date is written after the template fields so a template cannot override the policy, only when some flaw
    // has one, and never cleared; Jira may refuse it, which must not stop the ticket (optionalFields).
    buildTicketFields: (row, additionalFields, context) => {
      const due = dueContext(context?.ticketCreated);
      const dueDate = groupDueDate(row.sourceGroup, due);
      return {
        summary: row.summary,
        fields: { ...additionalFields, labels: row.labels, description: buildGroupDescriptionWiki(row.sourceGroup, due), ...(dueDate ? { duedate: dueDate } : {}) },
        optionalFields: dueDate ? ['duedate'] : undefined,
      };
    },
    rewriteDueDate: ({ regenItem, joiningItem, currentDueDate, ticketCreated }) => {
      if (currentDueDate === null) return groupDue(regenItem, ticketCreated);
      if (joiningItem === null) return null;
      const joining = groupDue(joiningItem, ticketCreated);
      return joining !== null && joining < currentDueDate ? joining : null;
    },
    dueDateNote: dueDate => `Due Date set to ${dueDate} from your SLA table`,
    // KTD9: this pop-up previously lived only in extension.ts's own (pre-consolidation) duplicate of
    // this flow; wiring it through the descriptor keeps it alive for both the command-triggered and
    // chat-only entry points once extension.ts is switched onto this shared session builder.
    onIssueTypeFetchFailed: host.onIssueTypeFetchFailed,
    // U6: wires reportImportHandler.ts's reverse stale-ticket check up to U5's own marker
    // label/predicate builder — rawItems here is always what readAndFilterVeracodeFile's rawItems
    // (or extension.ts's own captured pre-filter parse) produced: individual, unfiltered VeracodeFlaw[].
    stale: {
      markerLabel: VERACODE_STALE_MARKER_LABEL,
      labelToDedupKey: veracodeLabelToIssueId,
      buildActivePredicate: rawItems => buildVeracodeActiveFlawPredicate(rawItems as VeracodeFlaw[], settings.filter().includeStatuses),
    },
    // Finding folding (KTD1/KTD4): a row's item is its group of flaws, so merging is concatenation.
    fold: {
      itemOf: row => row.sourceGroup,
      combine: groups => groups.flat(),
      recordLabelsOf: group => buildGroupLabels(group),
      buildComment: (group, droppedKeys, details) => buildFoldedCommentWiki(group, droppedKeys, dueContext(details?.ticketCreated)),
      narrowToNew: (group, change) => flawsWithIds(group, change.newIds),
    },
    // Ticket merge, close mode (KTD1): items move to the kept ticket only when it lacks them; each source is linked,
    // commented on and closed without editing its text.
    ticketMerge: {
      mode: 'close',
      itemNoun: 'flaw',
      buildSourceComment: buildMergedSourceComment,
    },
    // Security overview export (KTD3): the report's own flaws are the exact detail, and the SLA table implies the same Due Date a ticket would get.
    overviewExport: {
      source: 'veracode',
      detailOf: row => ({ findings: row.sourceGroup.map(findingFromFlaw) }),
      summaryOf: row => row.summary,
      dueDateOf: row => groupDue(row.sourceGroup),
    },
    // Import ticket updates parity (KTD2): a folded group's findings are its flaw ids, recorded as
    // `veracode-issue-<id>` labels. Veracode offers the same three actions as Waltz (`rewrite`, `leave`, `new ticket`), so a
    // changed ticket is always rebuilt with its findings table; there is no `update` and no baseline, rating or summary rewrite.
    changeTracking: {
      findingNoun: 'flaw(s)',
      reportKeysOf: rawItems => (rawItems as VeracodeFlaw[]).map(flaw => flaw.issueId),
      describe: describeVeracodeChange,
      deriveActions: deriveRewriteActions,
      dueDateBackfill: { expectedFor: groupDue },
      // `new ticket` is a full ticket — the group's whole current content, all its labels and the template's — whose
      // title says which ticket it follows. The Relates link to that ticket is added by the caller.
      actionLabels: { 'follow-up': 'new ticket' },
      buildFollowUp: (row, _change, originalKey, additionalFields) => {
        const group = row.sourceGroup;
        const due = dueContext();
        const dueDate = groupDueDate(group, due);
        return {
          summary: buildFollowUpSummary(group, originalKey),
          fields: {
            ...additionalFields, labels: buildGroupLabels(group, templateLabelsOf(additionalFields)),
            description: buildGroupDescriptionWiki(group, due), ...(dueDate ? { duedate: dueDate } : {}),
          },
          optionalFields: dueDate ? ['duedate'] : undefined,
        };
      },
    },
  };
}

