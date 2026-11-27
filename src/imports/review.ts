// Report import: building the review — reading and filtering the report, the template-selection step, the dedup search,
// the review rows, the accepted list and the stale check — and rebuilding it from its report file. vscode-free; logging
// goes through the injected `onDiag`, progress through `onEvent`.
import * as fs from 'fs';
import { renderedExtras, type TicketService } from '../services/TicketService';
import type { ResolvedColumn } from '../services/extraColumns';
import type { IJiraClient } from '../jira/IJiraClient';
import { TemplateService } from '../templates/TemplateService';
import { FieldResolver } from '../templates/FieldResolver';
import type { DiagLogger } from '../utils/diagTypes';
import { NO_ISSUE_TYPE, resolveTemplateIssueType } from '../utils/searchConstraints';
import type { AcceptedEntry } from '../utils/waltzAccepted';
import {
  DEFAULT_DEDUP_CHUNK_SIZE, MAX_REPORT_BYTES, buildDedupJql, buildReviewRows, applyDroppedMembers, applyMissingDueDate, alignRewriteDefaults,
  readTargetDescriptions, fetchAllPages, findAlreadyTicketed, findStaleTickets, templateLabelsOf, buildTicketInfo, type DedupMap, type JqlIssueLike,
} from '../utils/reportImport';
import { buildStaleTicketGroups } from './cleanup';
import type { ReportImportDescriptor } from './descriptor';
import { buildReviewPage } from './rows';
import {
  CURRENT_SESSION_SCHEMA_VERSION, toAcceptedHidden,
  type ImportHooks, type ImportTemplateSelectionSession, type ReviewRowBase, type ReviewSession,
} from './types';

// Page size for the dedup search; fetchAllPages reads every page of each label chunk.
const DEDUP_PAGE_SIZE = 100;

/** What the review build reports as it goes: each search it starts, and each part it had to do without. */
export type ReviewBuildEvent =
  | { kind: 'checking-ticketed'; plural: string }
  | { kind: 'dedup-failed'; plural: string; error?: string }
  | { kind: 'descriptions-unread'; failed: number }
  | { kind: 'accepted-warning'; warning: string }
  | { kind: 'checking-stale' }
  | { kind: 'stale-truncated'; checked: number; totalFound: number; stale: number }
  | { kind: 'stale-failed' };

/** What the review build needs around it: the workspace for templates and the workflow cache, logging and progress. */
export interface ReviewBuildContext extends ImportHooks<ReviewBuildEvent> {
  workspaceRoot: string;
}

/**
 * Shared read+parse+filter orchestration (stat + size cap, then parse + filter). The two importers
 * differ only in how the file is read (utf-8 string for Veracode's XML, Buffer for Waltz's xlsx) and
 * in their own parse/filter functions — those differences are supplied by the caller, not
 * re-implemented here. Returns both the filtered `items` and the pre-filter `rawItems` (`parse()`'s
 * own output) directly, for callers that need the raw, unfiltered set (the stale-check predicate).
 */
export async function readAndFilterReport<TRaw, TItem>(
  filePath: string,
  readContent: (filePath: string) => Promise<TRaw>,
  parse: (raw: TRaw) => TItem[] | Promise<TItem[]>,
  filter: (items: TItem[]) => TItem[],
  maxBytes: number = MAX_REPORT_BYTES,
): Promise<{ items: TItem[]; rawItems: TItem[] }> {
  const stat = await fs.promises.stat(filePath);
  if (stat.size > maxBytes) {
    throw new Error(`File exceeds the ${maxBytes / (1024 * 1024)} MB size limit.`);
  }
  const raw = await readContent(filePath);
  const rawItems = await parse(raw);
  return { items: filter(rawItems), rawItems };
}

/**
 * The template-selection step of an import: the project's issue types (a failed read asks for the type later) and the
 * workspace's templates, offered for the report's filtered items.
 */
export async function buildImportTemplateSession<TItem, TRow extends ReviewRowBase>(
  items: TItem[],
  fileName: string,
  projectKey: string,
  jiraClient: IJiraClient,
  descriptor: ReportImportDescriptor<TItem, TRow>,
  rawItems: unknown[] = [],
  reportFilePath: string | undefined,
  workspaceRoot: string,
  onDiag?: DiagLogger,
): Promise<ImportTemplateSelectionSession<TItem>> {

  let issueTypes: string[] = [];
  try {
    const project = await jiraClient.getProject(projectKey);
    issueTypes = project.issueTypes.filter(t => !t.subtask).map(t => t.name);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    onDiag?.('warn', `Could not fetch issue types — ${projectKey}, you'll be asked to type it`, {
      projectKey, error: message,
    });
    descriptor.onIssueTypeFetchFailed?.(message, projectKey);
  }

  const availableTemplates: Array<{ name: string; issueType: string }> = (() => {
    if (!workspaceRoot) return [];
    try {
      return new TemplateService(workspaceRoot).loadTemplates().templates
        .map(t => ({ name: t.name, issueType: resolveTemplateIssueType(t.issueType, issueTypes) }));
    } catch (err) {
      onDiag?.('warn', 'Could not load templates — proceeding without', {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  })();

  return {
    reportFileName: fileName,
    ...(reportFilePath ? { reportFilePath } : {}),
    projectKey,
    items,
    rawItems,
    availableTemplates,
    availableIssueTypes: issueTypes.length > 0 ? issueTypes : [NO_ISSUE_TYPE],
    schemaVersion: CURRENT_SESSION_SCHEMA_VERSION,
  };
}

/** The picked template's resolved default fields, or the warning to show when it is gone or its fields could not be resolved. */
export async function resolveTemplateFields<TItem, TRow extends ReviewRowBase>(
  pickedTemplateName: string,
  projectKey: string,
  jiraClient: IJiraClient,
  descriptor: ReportImportDescriptor<TItem, TRow>,
  workspaceRoot: string,
  onDiag?: DiagLogger,
): Promise<{ additionalFields: Record<string, unknown>; problem?: { kind: 'missing' } | { kind: 'unresolved'; error: string } }> {
  if (!workspaceRoot) return { additionalFields: {} };
  try {
    const { templates } = new TemplateService(workspaceRoot).loadTemplates();
    const fullTemplate = templates.find(t => t.name === pickedTemplateName);
    if (fullTemplate) {
      const resolver = new FieldResolver(jiraClient, projectKey);
      return { additionalFields: await resolver.resolve(fullTemplate.defaultFields, fullTemplate.resolveFields) };
    }
    // The template was renamed or removed from .jira-templates.json between the list being
    // shown and this reply — additionalFields would otherwise silently stay {} with no signal,
    // unlike the thrown-error path right below, which does warn.
    onDiag?.('warn', `Template no longer found — proceeding without it — ${pickedTemplateName}`, { templateName: pickedTemplateName });
    return { additionalFields: {}, problem: { kind: 'missing' } };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    onDiag?.('warn', `Could not resolve template fields — ${pickedTemplateName}`, { templateName: pickedTemplateName, error: message });
    return { additionalFields: {}, problem: { kind: 'unresolved', error: message } };
  }
}

/** The issue with its extra columns' values rendered as plain text, for the importers' dedup records. */
function withRenderedExtras(issue: JqlIssueLike, columns: readonly ResolvedColumn[]): JqlIssueLike {
  if (columns.length === 0) return issue;
  return { ...issue, fields: { ...issue.fields, renderedExtra: renderedExtras(issue.fields as Record<string, unknown>, columns) } };
}

/** What a review is built from: the filtered report items, the choices made at import time, and where the report came from. */
export interface ImportReviewInput<TItem> {
  projectKey: string;
  items: TItem[];
  rawItems: unknown[];
  reportFilePath?: string;
  issueType: string;
  templateName: string | null;
  additionalFields: Record<string, unknown>;
  /** Target-ticket descriptions already read for this review, reused by a rebuild. */
  descriptionCache?: Record<string, string | null>;
  /** The extra columns whose values the dedup search reads beside each matched ticket's own fields. */
  extraColumns?: ResolvedColumn[];
}

/**
 * The dedup search, the review rows and the stale check, in one place: the first import and every
 * refresh or reload build the review through this, so a rebuilt review is the review a fresh import would show.
 * Reports its progress through `onEvent`; the caller decides what to show when nothing is left to review.
 */
export async function buildImportReview<TItem, TRow extends ReviewRowBase>(
  input: ImportReviewInput<TItem>,
  resolutions: Pick<IJiraClient, 'getResolutions'>,
  ticketService: TicketService,
  descriptor: ReportImportDescriptor<TItem, TRow>,
  ctx: ReviewBuildContext,
): Promise<{ session: ReviewSession<TRow>; degraded: boolean; dedupFailed: boolean }> {
  const { onDiag, onEvent } = ctx;
  // True when a Jira search the review depends on failed in whole or in part: the result is then a first-import best
  // effort, not something a refresh may put in place of a review that was built from complete data.
  let degraded = false;
  // True when any part of the dedup search failed: an item could then show as New although it has a ticket.
  let dedupFailed = false;
  const plural = descriptor.itemNoun.replace('(s)', 's'); // 'flaw(s)' -> 'flaws', 'component(s)' -> 'components'
  const templateLabels = templateLabelsOf(input.additionalFields);
  const extraColumns = input.extraColumns ?? [];

  // Dedup is optional — an importer that omits searchLabelOf/dedupKeyOf/labelToDedupKey (email)
  // has no per-item dedup key, so the "already ticketed" search is skipped entirely rather than run
  // and found empty. dedupMap stays empty, so every item is treated as new below.
  let dedupMap: DedupMap = new Map();
  if (descriptor.searchLabelOf && descriptor.dedupKeyOf && descriptor.labelToDedupKey) {
    onEvent?.({ kind: 'checking-ticketed', plural });
    // The template session was already cleared above, so a failure here must degrade gracefully
    // rather than throw with nothing left to resume from. findAlreadyTicketed() is itself
    // fault-tolerant per chunk and never rejects — this catch is a defensive backstop for a
    // failure outside the per-chunk loop (e.g. an error thrown by descriptor.searchLabelOf/labelToDedupKey
    // themselves). Total per-chunk coverage loss (every chunk failed) is a distinct, non-throwing
    // outcome, surfaced instead via the failedChunks/totalChunks check below, which reuses this
    // same user-facing warning for the total-coverage-loss case.
    try {
      // Flattens across every item's own multiple candidate labels (a folded Veracode
      // group contributes one label per member flaw) so every member flaw's label is searched for.
      const searchLabels = input.items.flatMap(descriptor.searchLabelOf);
      const result = await findAlreadyTicketed(
        searchLabels,
        DEFAULT_DEDUP_CHUNK_SIZE,
        // Resolution + created let buildReviewRows pick each item's newest open ticket; duedate lets Veracode see which have none.
        // Every page is read: the union of an item's tickets decides its target and known findings.
        chunk => fetchAllPages(
          (startAt, pageToken) => ticketService.searchTicketsRaw(buildDedupJql(input.projectKey, chunk), DEDUP_PAGE_SIZE, ['resolution', 'created', 'duedate', ...extraColumns.map(c => c.id)], startAt, pageToken)
            .then(r => ({ ...r, issues: (r.issues as JqlIssueLike[]).map(issue => withRenderedExtras(issue, extraColumns)) })),
          DEDUP_PAGE_SIZE,
          undefined,
          issue => issue.key,
        ),
        descriptor.labelToDedupKey,
        onDiag,
      );
      dedupMap = result.map;
      if (result.failedChunks > 0) {
        degraded = true;
        dedupFailed = true;
      }
      if (result.totalChunks > 0 && result.failedChunks === result.totalChunks) {
        onDiag?.('warn', `Could not check for already-ticketed ${plural} — proceeding without dedup`, {
          projectKey: input.projectKey, failedChunks: result.failedChunks, totalChunks: result.totalChunks,
        });
        onEvent?.({ kind: 'dedup-failed', plural });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      onDiag?.('warn', `Could not check for already-ticketed ${plural} — proceeding without dedup`, {
        projectKey: input.projectKey, error: message,
      });
      onEvent?.({ kind: 'dedup-failed', plural, error: message });
      dedupMap = new Map();
      degraded = true;
      dedupFailed = true;
    }
  }

  // Remediation dates: an importer with its own action policy compares what each target ticket recorded with
  // the report, so it reads those tickets' descriptions (the search cannot carry them: on Cloud it returns ADF).
  // A read that fails leaves that ticket's description unknown, which skips the date comparison for it and marks the
  // review degraded so a refresh does not replace a review built from complete data.
  const waltzStyle = !!descriptor.changeTracking?.readsTargetDescriptions && !!descriptor.dedupKeyOf;
  let ticketDescriptions: Record<string, string | null> | undefined;
  if (waltzStyle && dedupMap.size > 0) {
    const reads = await readTargetDescriptions<TItem>({
      items: input.items,
      dedupMap,
      dedupKeyOf: descriptor.dedupKeyOf!,
      cache: input.descriptionCache,
      read: async key => {
        const description = (await ticketService.getIssue(key)).fields.description as unknown;
        return typeof description === 'string' ? description : null;
      },
      onFail: (key, err) => onDiag?.('warn', `Could not read the description of ${key} — its dates are not compared`, {
        issueKey: key, error: err instanceof Error ? err.message : String(err),
      }),
    });
    ticketDescriptions = reads.read;
    if (reads.failed > 0) {
      degraded = true;
      onEvent?.({ kind: 'descriptions-unread', failed: reads.failed });
    }
  }

  // Every matched item gets its lightweight row fields built eagerly (severity/CWE/summary/
  // labels) — no pre-build cap here anymore. The review screen pages through the full "new" set
  // instead of silently dropping the remainder of a run (buildReviewPage below); an importer whose
  // full ticket description is expensive to build (Veracode's folded-group description) defers
  // that part to ticket-creation time via its own buildTicketFields, rather than paying the cost
  // here for every candidate the user may never confirm.
  const dedupKeyOf = descriptor.dedupKeyOf ?? (() => []);
  // Accepted-CVE list: applied to the New items only, after the dedup split, so Already ticketed
  // and Stale keep seeing the full report. A missing list file or workspace hides nothing; a
  // broken one hides nothing and is reported.
  const acceptedHidden = { cves: 0, belowFloor: 0, components: 0 };
  let narrowNew: ((item: TItem) => TItem | null) | undefined;
  let dropTicketed: ((item: TItem) => boolean) | undefined;
  let acceptedEntries: AcceptedEntry[] = [];
  if (descriptor.accepted) {
    const accepted = descriptor.accepted;
    const loaded = accepted.service()?.load();
    if (loaded?.warning) {
      onDiag?.('warn', 'Accepted-CVE list could not be applied in full', { warning: loaded.warning });
      onEvent?.({ kind: 'accepted-warning', warning: loaded.warning });
    }
    if (loaded && loaded.entries.length > 0) {
      acceptedEntries = loaded.entries;
      narrowNew = item => {
        const narrowed = accepted.narrow(item, loaded.entries);
        acceptedHidden.cves += narrowed.hiddenCves;
        acceptedHidden.belowFloor += narrowed.belowFloor;
        acceptedHidden.components += narrowed.hiddenComponents;
        return narrowed.item;
      };
      dropTicketed = item => {
        const dropped = accepted.isAccepted(item, loaded.entries);
        if (dropped) acceptedHidden.components++;
        return dropped;
      };
    }
  }
  // Waltz reads them to tell a filtered component from a dropped one; Veracode's close-mode merge to tell a filtered flaw from a gone one.
  const reportKeys = waltzStyle || descriptor.ticketMerge?.mode === 'close' ? descriptor.changeTracking?.reportKeysOf?.(input.rawItems) ?? [] : undefined;
  let allRows = buildReviewRows<TItem, TRow>(
    input.items,
    dedupMap,
    dedupKeyOf,
    item => descriptor.buildRowFields(item, templateLabels),
    descriptor.changeTracking,
    narrowNew,
    dropTicketed,
  );
  // A member that left the report counts as a change for every row of its ticket, and rows of one
  // ticket share a `rewrite` default because `rewrite` rebuilds the whole ticket.
  if (waltzStyle && descriptor.fold && descriptor.labelToDedupKey) {
    allRows = applyDroppedMembers<TItem, TRow>({
      rows: allRows,
      dedupMap,
      itemOf: descriptor.fold.itemOf,
      dedupKeyOf,
      labelToDedupKey: descriptor.labelToDedupKey,
      reportKeys: new Set(reportKeys),
      derive: descriptor.changeTracking!.deriveActions!,
    });
  }
  // A Due Date is set once (Veracode): an open ticket without one is a change for dates, before the shared rewrite defaults align.
  const backfill = descriptor.changeTracking?.dueDateBackfill;
  if (backfill && descriptor.fold && descriptor.changeTracking?.deriveActions) {
    allRows = applyMissingDueDate<TItem, TRow>({
      rows: allRows, dedupMap, itemOf: descriptor.fold.itemOf, expectedFor: backfill.expectedFor, derive: descriptor.changeTracking.deriveActions,
    });
  }
  if (descriptor.changeTracking?.deriveActions) allRows = alignRewriteDefaults(allRows);
  const initialPage = buildReviewPage(allRows, 0);
  const hiddenCounts = toAcceptedHidden(acceptedHidden);

  let reviewSession: ReviewSession<TRow> = {
    projectKey: input.projectKey,
    issueType: input.issueType,
    templateName: input.templateName,
    additionalFields: input.additionalFields,
    ...(input.reportFilePath ? { reportFilePath: input.reportFilePath } : {}),
    allRows,
    rows: initialPage.rows,
    page: initialPage.page,
    ...(ticketDescriptions ? { ticketDescriptions } : {}),
    ...(descriptor.dedupKeyOf ? { ticketInfo: buildTicketInfo(dedupMap) } : {}),
    ...(reportKeys ? { reportKeys } : {}),
    ...(hiddenCounts ? { acceptedHidden: hiddenCounts } : {}),
    schemaVersion: CURRENT_SESSION_SCHEMA_VERSION,
  };

  // Reverse stale-ticket check — an importer with no marker-label concept (email) omits
  // `descriptor.stale` and this whole block is skipped, exactly like the dedup block above.
  if (descriptor.stale) {
    onEvent?.({ kind: 'checking-stale' });
    const issueDetails = new Map<string, { summary: string; currentStatus: string; issueType: string }>();
    const staleResult = await findStaleTickets(
      input.projectKey,
      descriptor.stale.markerLabel,
      async (jql, maxResults, startAt, pageToken) => {
        const result = await ticketService.searchTicketsRaw(jql, maxResults, [], startAt, pageToken);
        // Captured as a side effect of the search findStaleTickets() already runs — searchJql's
        // baseFields always include summary/status/issuetype (see JiraApiClient.ts), so this needs
        // no second fetch keyed by the returned stale keys. `JiraIssue.fields` already types these
        // (issuetype is optional for older fixtures only), so no cast is needed to read them.
        for (const issue of result.issues) {
          issueDetails.set(issue.key, {
            summary: issue.fields.summary,
            currentStatus: issue.fields.status.name,
            issueType: issue.fields.issuetype?.name ?? '',
          });
        }
        // JiraIssue[] structurally satisfies JqlIssueLike[] (a strict subset of fields), so no
        // narrowing cast is needed on the return either.
        return result;
      },
      descriptor.stale.labelToDedupKey,
      descriptor.stale.buildActivePredicate(input.rawItems, acceptedEntries),
      onDiag,
    );

    if (staleResult.searchFailed) {
      degraded = true;
      onEvent?.({ kind: 'stale-failed' });
    } else {
      // Outside the `stale.length > 0` branch below: this must render whenever the search was
      // truncated, however many of the checked tickets turned out stale, so coverage is never
      // silently lost past one search page. `totalFound` is the total open marker-labeled ticket
      // count the search matched, not a stale count.
      if (staleResult.truncated) {
        onEvent?.({ kind: 'stale-truncated', checked: staleResult.checked, totalFound: staleResult.totalFound, stale: staleResult.stale.length });
      }
      // Accepted components: an importer with an accepted list keeps the open tickets it did not flag.
      if (descriptor.accepted && staleResult.pending.length > 0) {
        const staleCandidates = staleResult.pending.flatMap(m => {
          const detail = issueDetails.get(m.key);
          return detail ? [{ key: m.key, summary: detail.summary, currentStatus: detail.currentStatus, issueType: detail.issueType, activeIds: m.ids }] : [];
        });
        if (staleCandidates.length > 0) reviewSession = { ...reviewSession, staleCandidates };
      }
      if (staleResult.stale.length > 0) {
        // Code-review fix: buildStaleTicketGroups() (and the synchronous
        // TemplateService.loadTemplates() it calls internally) had no guard here, unlike the
        // dedup-search block above — a transient failure (auth blip, network timeout, malformed
        // templates file) would propagate past the point where the prior template-selection
        // session was already cleared and discard the whole in-progress review (the dedup work,
        // the folded rows, the page the user was on). Degrade the same way
        // `staleResult.searchFailed` already does instead of throwing.
        try {
          const grouped = await buildStaleTicketGroups(staleResult.stale, issueDetails, input.projectKey, resolutions, ctx.workspaceRoot, onDiag);
          // The target (and any resolution) is picked only when the user closes selected tickets
          // — nothing is asked here.
          reviewSession = { ...reviewSession, staleTickets: grouped };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          onDiag?.('warn', 'Could not check for stale tickets — proceeding without a stale-ticket section', {
            projectKey: input.projectKey, error: message,
          });
          onEvent?.({ kind: 'stale-failed' });
        }
      }
    }
  }

  return { session: reviewSession, degraded, dedupFailed };
}

