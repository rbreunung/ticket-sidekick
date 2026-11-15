// The Waltz OSS report importer: reading a report, its labels and stale-check predicate, the accepted list, and the
// descriptor the shared import flow runs on. vscode-free: the settings and the workspace folder are passed in as readers.
import * as fs from 'fs';
import type { DiagLogger } from '../utils/diagTypes';
import {
  parseWaltzReport, filterComponents, dueDateFields, sanitizeComponentLabel, buildGroupSummary, buildGroupLabels, buildGroupDescriptionWiki, buildFoldedCommentWiki,
  describeWaltzRowChange, deriveWaltzActions, buildRecordLabels, buildCveLabel, buildRatingLabel, buildUpdateCommentWiki,
  buildFollowUpSummary, rewriteSummaryRating, highestRating,
  type WaltzComponent, type WaltzReviewRow,
} from '../utils/waltzReport';
import { componentFromWaltz } from '../utils/securityOverview';
import { AcceptedListService } from '../services/AcceptedListService';
import { narrowGroup, acceptedEntriesOf, acceptedComponentEntriesOf, acceptedComponentKeys, isComponentAccepted, type AcceptedEntry } from '../utils/waltzAccepted';
import { stringOrNull, templateLabelsOf } from '../utils/reportImport';
import type { ImportDescriptorHost, ReportImportDescriptor } from './descriptor';
import { readAndFilterReport } from './review';

/** The Waltz settings and the workspace folder, read each time they are needed. */
export interface WaltzSettings {
  /** `minVulnRating`, `includeRemediationActions` and the resolved `maxReportSizeMB` in bytes. */
  filter: () => { minVulnRating: string; includeRemediationActions: string[]; maxReportBytes: number };
  /** `minVulnRating` alone, for narrowing a group against the accepted list. */
  minVulnRating: () => string;
  /** The folder the accepted list lives in; undefined when no workspace folder is open. */
  workspaceRoot: () => string | undefined;
}

async function readAndFilterWaltzFile(filePath: string, settings: WaltzSettings, onDiag?: DiagLogger): Promise<{ items: WaltzComponent[][]; rawItems: WaltzComponent[] }> {
  // parseWaltzReport() itself also re-checks size (single source of truth used by the pure unit
  // tests too) — both checks share the same resolved maxReportBytes so they agree with each other
  // and with the user's setting.
  const { maxReportBytes, ...filterConfig } = settings.filter();
  // BuildWaltzActiveComponentPredicate needs the raw, unfiltered components (before
  // minVulnRating/includeRemediationActions) — readAndFilterReport returns them directly as
  // `rawItems` alongside the filtered set, no closure capture needed.
  const { items, rawItems } = await readAndFilterReport(
    filePath,
    fp => fs.promises.readFile(fp),
    raw => parseWaltzReport(raw, maxReportBytes, onDiag),
    components => filterComponents(components, filterConfig),
    maxReportBytes,
  );
  // Waltz folds nothing automatically: each component is its own one-member group, so the
  // shared review flow can treat a Waltz item and a Veracode item alike.
  return { items: items.map(component => [component]), rawItems };
}

// The `oss-dependency` label every Waltz-imported ticket carries (alongside its own
// `oss-dep-...` component label) — reportImport.ts's findStaleTickets() searches on this to find
// open tickets whose component has disappeared from the current report.
const WALTZ_STALE_MARKER_LABEL = 'oss-dependency';

// Reused directly by the descriptor's own labelToDedupKey below (dedup search) and by
// findStaleTickets()'s labelToDedupKey (stale search) so both parse the identical
// `oss-dep-...` label shape sanitizeComponentLabel() produces, from one implementation.
export function waltzLabelToDedupKey(label: string): string | null {
  return label.startsWith('oss-dep-') ? label : null;
}

/**
 * Builds the "is this component still active" predicate findStaleTickets() needs. A
 * component is active when it's present in the *raw* parsed report (before the
 * minVulnRating/includeRemediationActions filter that decides what gets a *new* ticket) with a
 * remediationAction that still matches `includeRemediationActions`. Deliberately ignores
 * minVulnRating, so a component that dropped below the rating floor but is still open does not make its
 * ticket stale.
 */
function buildWaltzActiveComponentPredicate(
  rawComponents: WaltzComponent[],
  includeRemediationActions: string[],
  acceptedEntries: AcceptedEntry[] = [],
): (dedupKey: string) => boolean {
  const allowedActions = new Set(includeRemediationActions.map(a => a.trim()));
  // A component accepted as a whole is not an active finding even when the report still lists it, so
  // a ticket covering only accepted components is offered for closing.
  const acceptedKeys = acceptedComponentKeys(acceptedEntries);
  const actionByKey = new Map(rawComponents
    .filter(c => !isComponentAccepted(c.nameVersion, acceptedKeys))
    .map(c => [sanitizeComponentLabel(c.nameVersion), (c.remediationAction ?? '').trim()] as const));
  return (dedupKey: string) => {
    const action = actionByKey.get(dedupKey);
    return action !== undefined && allowedActions.has(action);
  };
}

/**
 * The Waltz descriptor. Its settings are read through `settings` each time they are needed, so a changed setting
 * applies to the next step without a restart; `host` supplies the review columns and where the
 * importer's own log lines go.
 */
export function createWaltzDescriptor(settings: WaltzSettings, host: ImportDescriptorHost<WaltzReviewRow>): ReportImportDescriptor<WaltzComponent[], WaltzReviewRow> {
  return {
    descriptorKind: 'waltz',
    scope: 'jira.waltz',
    importLabel: 'Waltz OSS',
    itemNoun: 'component(s)',
    filterKindLabel: 'rating/remediation',
    noMatchMessage:
      'No components in this report matched your current filters ' +
      '(`ticketSidekick.waltz.minVulnRating` / `ticketSidekick.waltz.includeRemediationActions`).',
    fileFilter: { label: 'OSS report', extensions: ['xlsx'] },
    filePickerTitle: 'Select OSS Report (.xlsx)',
    parseAndFilter: filePath => readAndFilterWaltzFile(filePath, settings, host.onDiag),
    sessionKeys: {
      templateSelection: 'jira.session.waltzTemplateSelection',
      review: 'jira.session.waltzReview',
    },
    // One label/key per member component, so a ticket a user merged by hand is found from any member.
    searchLabelOf: group => group.map(component => sanitizeComponentLabel(component.nameVersion)),
    dedupKeyOf: group => group.map(component => sanitizeComponentLabel(component.nameVersion)),
    labelToDedupKey: waltzLabelToDedupKey,
    buildRowFields: (group, templateLabels) => ({
      nameVersion: group.length === 1 ? group[0].nameVersion : `${group[0].nameVersion} (+${group.length - 1} more)`,
      maxVulnRating: highestRating(group),
      summary: buildGroupSummary(group),
      labels: buildGroupLabels(group, templateLabels),
      descriptionWiki: buildGroupDescriptionWiki(group),
      sourceGroup: group,
    }),
    reviewColumns: host.reviewColumns,
    itemRefFor: row => row.nameVersion,
    // The Due Date is written after the template fields so a template cannot override the report, only
    // when the row has a date, and never cleared; Jira may refuse it, which must not stop the ticket.
    buildTicketFields: (row, additionalFields) => {
      const due = dueDateFields(row.sourceGroup);
      return {
        summary: row.summary,
        fields: { ...additionalFields, labels: row.labels, description: row.descriptionWiki, ...due.fields },
        optionalFields: due.optionalFields,
      };
    },
    // A rewrite overwrites the Due Date with the regenerated group's date, whatever the ticket holds.
    rewriteDueDate: ({ regenItem }) => stringOrNull(dueDateFields(regenItem).fields.duedate),
    dueDateNote: dueDate => `Due Date set to ${dueDate} from the report (replaces any date edited by hand)`,
    // No onIssueTypeFetchFailed: a failed issue-type fetch is only logged for Waltz.
    // The reverse stale-ticket check — rawItems here is always what readAndFilterWaltzFile's
    // rawItems produced: unfiltered WaltzComponent[].
    stale: {
      markerLabel: WALTZ_STALE_MARKER_LABEL,
      labelToDedupKey: waltzLabelToDedupKey,
      buildActivePredicate: (rawItems, acceptedEntries) => buildWaltzActiveComponentPredicate(rawItems as WaltzComponent[], settings.filter().includeRemediationActions, acceptedEntries),
    },
    // Finding folding: a row's item is its group of components, so merging is concatenation.
    fold: {
      itemOf: row => row.sourceGroup,
      combine: groups => groups.flat(),
      recordLabelsOf: group => buildGroupLabels(group),
      buildComment: (group, droppedKeys, details) => buildFoldedCommentWiki(group, droppedKeys, details),
    },
    // Security overview export: the report's own components are the exact detail, and the report implies the same Due Date a ticket would get.
    overviewExport: {
      source: 'waltz',
      detailOf: row => ({ components: row.sourceGroup.map(componentFromWaltz) }),
      summaryOf: row => row.summary,
      dueDateOf: row => dueDateFields(row.sourceGroup).fields.duedate ?? null,
    },
    // Waltz ticket merge: the survivor's comment opens by naming the tickets it absorbed.
    ticketMerge: {
      buildCommentPreface: absorbedKeys => `h4. Merged tickets\nThis ticket took over the items of ${absorbedKeys.join(', ')}, which were closed as duplicates of it.`,
    },
    // Accepted-CVE list: component + CVE pairs the team accepted stay off the New screen.
    accepted: {
      itemOf: row => row.sourceGroup,
      service: () => {
        const workspaceRoot = settings.workspaceRoot();
        return workspaceRoot ? new AcceptedListService(workspaceRoot) : null;
      },
      narrow: (group, entries) => {
        const narrowed = narrowGroup(group, entries, settings.minVulnRating());
        return { item: narrowed.group, hiddenCves: narrowed.hiddenCves, belowFloor: narrowed.belowFloor, hiddenComponents: narrowed.hiddenComponents };
      },
      isAccepted: (group, entries) => {
        const keys = acceptedComponentKeys(entries);
        return group.length > 0 && group.every(c => isComponentAccepted(c.nameVersion, keys));
      },
      componentEntriesOf: (group, reason) => acceptedComponentEntriesOf(group, reason),
      entriesOf: (group, reason) => acceptedEntriesOf(group, reason),
    },
    // Import ticket updates parity: a component's findings are recorded as one
    // `oss-cve-<id>` label per CVE plus exactly one `oss-rating-<rating>` label, which `update`
    // replaces rather than accumulates. A rating rise also rewrites the summary's rating suffix.
    changeTracking: {
      findingNoun: 'CVE(s)',
      // Change tracking only ever sees Already-ticketed rows, and Waltz never folds those (merges act
      // on New rows only), so the group holds exactly one component here.
      describe: (group, knownLabels, context) => describeWaltzRowChange(group[0], knownLabels, context),
      deriveActions: deriveWaltzActions,
      readsTargetDescriptions: true,
      reportKeysOf: rawItems => (rawItems as WaltzComponent[]).map(c => sanitizeComponentLabel(c.nameVersion)),
      recordLabelsOf: (row, change) => {
        if (change.kind === 'baseline') return buildRecordLabels(row.sourceGroup[0]);
        const labels = change.newIds.map(buildCveLabel);
        if (change.ratingRise) labels.push(buildRatingLabel(change.ratingRise.to));
        return labels.filter(l => l !== '');
      },
      removeLabelPrefix: 'oss-rating-',
      buildUpdateComment: (row, change, { summaryUnchanged }) => buildUpdateCommentWiki(
        row.sourceGroup[0], { newCveIds: change.newIds, ratingRise: change.ratingRise }, { summaryUnchanged },
      ),
      rewriteSummary: (summary, change) => (change.ratingRise
        ? rewriteSummaryRating(summary, change.ratingRise.to)
        : undefined),
      // `new ticket` is a full ticket — the component's whole current content and dates, all its record labels and the
      // template's, and the Due Date — whose title says which ticket it follows. The Relates link to that ticket is added by the caller.
      actionLabels: { 'follow-up': 'new ticket' },
      buildFollowUp: (row, _change, originalKey, additionalFields) => {
        const group = row.sourceGroup;
        const due = dueDateFields(group);
        return {
          summary: buildFollowUpSummary(group[0], originalKey),
          fields: {
            ...additionalFields,
            labels: buildGroupLabels(group, templateLabelsOf(additionalFields)),
            description: buildGroupDescriptionWiki(group),
            ...due.fields,
          },
          optionalFields: due.optionalFields,
        };
      },
    },
  };
}

