// Report import: merging Waltz tickets (`merge <sources> into <survivor>`) — the confirmation, the writes in
// order, the target-status question, retry or ignore after a failed step, and the final report.
import * as vscode from 'vscode';
import { logDiag } from '../../utils/diagLog';
import { formatKeyLink, type TicketService } from '../../services/TicketService';
import { buildMergePlan, resolveMergeSides } from '../../utils/ticketMerge';
import {
  buildChatCommandLink, buildMergePrompt, buildStaleTargetOptions, emptyImportOutcomes, formatStaleTargetOption, isTicketedRowFinished, parseMergeRunReply,
  planStaleTransitions, safeMarkdownText, staleTargetState, ticketedTargetKey,
  type MergeRun, type MergeStep, type ReviewRowBase, type ReviewSession, type StaleTicketGroup,
} from '../sessionState';
import { trustedChatMarkdown } from '../../utils/chatMarkdown';
import { buildStaleTicketGroups, transitionTickets } from './cleanupHandler';
import { planRewrite, writeRewrite } from './importAddToTicket';
import type { ReportImportDescriptor } from './reportImportTypes';

/** What a call leaves behind: a question is waiting (the session must be saved), the run is over, or the reply was refused with nothing started. */
export type MergeTurn = 'waiting' | 'finished' | 'refused';

type Issue = Awaited<ReturnType<TicketService['getIssue']>>;

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

function sourceRowsOf<TRow extends ReviewRowBase>(session: ReviewSession<TRow>, sources: string[]): TRow[] {
  // Rows an earlier merge in this review folded into one of the sources travel with it.
  return session.allRows.filter(r => r.existingTicketKey !== null
    && (sources.includes(ticketedTargetKey(r)) || (r.result?.status === 'done' && r.result.action === 'merge' && sources.includes(r.result.into))));
}

/** The labels of the survivor and every source, so a rewrite can name every recorded finding it would no longer cover. */
async function recordedLabels(ticketService: TicketService, keys: string[]): Promise<string[]> {
  const labels: string[] = [];
  for (const key of keys) labels.push(...((await ticketService.getIssue(key)).fields.labels ?? []));
  return [...new Set(labels)];
}

/**
 * KTD2: step one of `merge … into …`. Reads every ticket, then shows what would happen with the warnings (R10) and
 * fallbacks (R9) the user should see first. Writes nothing; its single link is the confirmation.
 */
export async function showMergePrompt<TItem, TRow extends ReviewRowBase>(
  session: ReviewSession<TRow>,
  sourceRefs: string[],
  targetRef: string,
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
  descriptor: ReportImportDescriptor<TItem, TRow>,
  baseUrl?: string,
): Promise<MergeTurn> {
  const sides = resolveMergeSides(session.allRows, sourceRefs, targetRef);
  if (!sides.ok) {
    stream.markdown(`_Nothing was written. ${safeMarkdownText(sides.reason)}_\n\n`);
    return 'refused';
  }
  const keys = [sides.survivor, ...sides.sources];
  const issues = new Map<string, Issue>();
  try {
    for (const key of keys) issues.set(key, await ticketService.getIssue(key));
  } catch (err) {
    logDiag(descriptor.scope, 'warn', 'Could not read the tickets to merge', { keys, error: errorText(err) });
    stream.markdown(`✗ Could not read all the tickets, so nothing was written: ${safeMarkdownText(errorText(err))}\n\n`);
    return 'refused';
  }

  const warnings: string[] = [];
  const marker = descriptor.stale?.markerLabel;
  for (const key of keys) {
    const issue = issues.get(key)!;
    const isSurvivor = key === sides.survivor;
    if (issue.fields.resolution != null) {
      warnings.push(isSurvivor
        ? `${key} is resolved. You can still merge into it, but nobody may be watching it.`
        : `${key} is already resolved, so it is rewritten and linked but not closed.`);
    }
    if (marker && !(issue.fields.labels ?? []).includes(marker)) {
      warnings.push(`${key} was not created by an import, so rewriting from the report replaces text the report does not know.`);
    }
  }
  try {
    if (!(await ticketService.getLinkTypeNames()).some(n => n.toLowerCase() === 'duplicate')) {
      warnings.push('This project has no Duplicate link type, so the tickets are linked as Relates instead.');
    }
  } catch { /* an unreadable list is not a reason to refuse; the link step tries Duplicate */ }
  try {
    if (!(await ticketService.getResolutions()).some(r => r.name.toLowerCase() === 'duplicate')) {
      warnings.push('This project has no Duplicate resolution, so you pick the resolution from its list when the tickets are closed.');
    }
  } catch {
    warnings.push('The resolutions could not be read, so the tickets may be closed without one.');
  }

  const labels = [...new Set(keys.flatMap(key => issues.get(key)!.fields.labels ?? []))];
  const rewrite = planRewrite(session, descriptor, sides.survivor, labels, sourceRowsOf(session, sides.sources));
  const ticket = (key: string) => ({ key, summary: issues.get(key)!.fields.summary ?? '', status: issues.get(key)!.fields.status?.name ?? null });
  stream.markdown(trustedChatMarkdown(buildMergePrompt({
    survivor: ticket(sides.survivor), sources: sides.sources.map(ticket), warnings, droppedKeys: rewrite.droppedKeys, baseUrl,
  })));
  return 'waiting';
}

/** The confirmed `merge … into … confirm`: records the run on the session and starts it. */
export async function startMerge<TItem, TRow extends ReviewRowBase>(
  session: ReviewSession<TRow>,
  sourceRefs: string[],
  targetRef: string,
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
  descriptor: ReportImportDescriptor<TItem, TRow>,
  baseUrl?: string,
): Promise<MergeTurn> {
  const sides = resolveMergeSides(session.allRows, sourceRefs, targetRef);
  if (!sides.ok) {
    stream.markdown(`_Nothing was written. ${safeMarkdownText(sides.reason)}_\n\n`);
    return 'refused';
  }
  let linkType = 'Duplicate';
  try {
    const names = await ticketService.getLinkTypeNames();
    if (!names.some(n => n.toLowerCase() === 'duplicate') && names.includes('Relates')) linkType = 'Relates';
  } catch { /* try Duplicate; a refusal is a failed step */ }
  session.mergeRun = { survivor: sides.survivor, sources: sides.sources, steps: buildMergePlan(sides.survivor, sides.sources), linkType };
  logDiag(descriptor.scope, 'info', `${descriptor.importLabel} import — merge started`, { survivor: sides.survivor, sources: sides.sources, linkType });
  return advance(session, ticketService, stream, descriptor, baseUrl);
}

/** KTD3: a reply while a merge waits — a retry or ignore after a failed step, a target status, a resolution, or stop. */
export async function handleMergeRunReply<TItem, TRow extends ReviewRowBase>(
  reply: string,
  session: ReviewSession<TRow>,
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
  descriptor: ReportImportDescriptor<TItem, TRow>,
  baseUrl?: string,
): Promise<MergeTurn> {
  const run = session.mergeRun!;
  const parsed = parseMergeRunReply(reply, run);
  switch (parsed.kind) {
    case 'invalid':
      stream.markdown("_Didn't understand that — answer the question below._\n\n");
      await askAgain(run, stream, baseUrl);
      return 'waiting';
    case 'cancel':
      stream.markdown('_Merge stopped here. Steps already done stay as they are._\n\n');
      for (const step of run.steps) if (step.status === 'pending' || step.status === 'failed') step.status = 'skipped';
      return finish(session, stream, descriptor, baseUrl);
    case 'retry':
    case 'ignore':
      for (const step of run.steps) {
        if (step.status !== 'failed') continue;
        step.status = parsed.kind === 'retry' ? 'pending' : 'skipped';
        if (parsed.kind === 'retry') delete step.error;
        // A close that failed part-way left the ticket in another status; the groups are read again so the retry plans from it.
        if (parsed.kind === 'retry' && step.kind === 'close') run.closeGroups = undefined;
      }
      run.awaiting = undefined;
      return advance(session, ticketService, stream, descriptor, baseUrl);
    case 'target':
      run.closeTarget = parsed.option;
      if (!run.duplicateResolution && (run.resolutionOptions?.length ?? 0) > 0) {
        run.awaiting = 'resolution';
        await askAgain(run, stream, baseUrl);
        return 'waiting';
      }
      return closeGroup(session, run.duplicateResolution, ticketService, stream, descriptor, baseUrl);
    case 'resolution':
      return closeGroup(session, parsed.resolution ?? undefined, ticketService, stream, descriptor, baseUrl);
  }
}

/** Runs the pending steps in order until one fails, the close needs the user, or everything is done. */
async function advance<TItem, TRow extends ReviewRowBase>(
  session: ReviewSession<TRow>,
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
  descriptor: ReportImportDescriptor<TItem, TRow>,
  baseUrl?: string,
): Promise<MergeTurn> {
  const run = session.mergeRun!;
  for (const step of run.steps) {
    if (step.status !== 'pending') continue;
    if (step.kind === 'close') break; // the closes are asked for and run together below
    try {
      await executeStep(step, run, session, ticketService, descriptor, baseUrl);
      step.status = 'done';
    } catch (err) {
      return failStep(step, err, run, stream, descriptor, baseUrl);
    }
  }
  return closePhase(session, ticketService, stream, descriptor, baseUrl);
}

async function executeStep<TItem, TRow extends ReviewRowBase>(
  step: MergeStep,
  run: MergeRun,
  session: ReviewSession<TRow>,
  ticketService: TicketService,
  descriptor: ReportImportDescriptor<TItem, TRow>,
  baseUrl?: string,
): Promise<void> {
  const fold = descriptor.fold!;
  const sourceRows = sourceRowsOf(session, run.sources);
  switch (step.kind) {
    case 'survivor-rewrite': {
      const labels = await recordedLabels(ticketService, [run.survivor, ...run.sources]);
      const plan = planRewrite(session, descriptor, run.survivor, labels, sourceRows);
      const written = await writeRewrite(ticketService, descriptor, run.survivor, plan.regenItem);
      if (written.droppedFields.length > 0) step.note = 'Jira refused the Due Date; written without it';
      run.droppedKeys = plan.droppedKeys;
      return;
    }
    case 'survivor-comment': {
      const preface = descriptor.ticketMerge!.buildCommentPreface(run.sources);
      // A replayed confirmation (a second click, an old link) would post the same comment again.
      if (await ticketService.hasCommentStartingWith(run.survivor, preface)) {
        step.note = 'already commented';
        return;
      }
      const body = fold.buildComment(fold.combine(sourceRows.map(fold.itemOf)), run.droppedKeys ?? []);
      await ticketService.addComment(run.survivor, `${preface}\n\n${body}`, baseUrl);
      return;
    }
    case 'link': {
      if (await ticketService.hasLinkBetween(step.key, run.survivor, run.linkType ?? 'Duplicate')) {
        step.note = 'already linked';
        return;
      }
      await ticketService.linkIssues(step.key, run.survivor, run.linkType ?? 'Duplicate');
      if (run.linkType === 'Relates') step.note = 'linked as Relates (no Duplicate link type)';
      return;
    }
    case 'source-rewrite':
      await ticketService.markTicketMerged(step.key, run.survivor);
      return;
    case 'close':
      return; // handled by the close phase
  }
}

async function failStep<TItem, TRow extends ReviewRowBase>(
  step: MergeStep,
  err: unknown,
  run: MergeRun,
  stream: vscode.ChatResponseStream,
  descriptor: ReportImportDescriptor<TItem, TRow>,
  baseUrl?: string,
): Promise<MergeTurn> {
  step.status = 'failed';
  step.error = errorText(err);
  run.awaiting = 'decision';
  logDiag(descriptor.scope, 'error', `Merge step failed — ${step.kind} ${step.key}`, { survivor: run.survivor, step: step.kind, key: step.key, error: step.error });
  await askAgain(run, stream, baseUrl);
  return 'waiting';
}

const STEP_LABEL: Record<MergeStep['kind'], string> = {
  'survivor-rewrite': 'rewrite the kept ticket',
  'survivor-comment': 'comment on the kept ticket',
  link: 'link as a duplicate',
  'source-rewrite': 'mark the ticket as merged',
  close: 'close',
};

function stepSummary(step: MergeStep): string {
  const mark = step.status === 'done' ? '✓' : step.status === 'failed' ? '✗' : step.status === 'skipped' ? '–' : '·';
  return `${mark} ${STEP_LABEL[step.kind]}${step.note ? ` (${safeMarkdownText(step.note)})` : ''}${step.error ? ` — ${safeMarkdownText(step.error)}` : ''}`;
}

/** The step-by-step state of every ticket in the run, each key a link. */
function ticketLines(run: MergeRun, baseUrl?: string): string[] {
  const forKey = (key: string) => run.steps.filter(s => s.key === key).map(stepSummary);
  return [
    `**${formatKeyLink(run.survivor, baseUrl)}** (kept)`,
    ...forKey(run.survivor).map(l => `  - ${l}`),
    ...run.sources.flatMap(key => [`**${formatKeyLink(key, baseUrl)}** (cancelled)`, ...forKey(key).map(l => `  - ${l}`)]),
  ];
}

/** Re-states the question the run is waiting on: the failure with retry and ignore, the target status, or the resolution. */
async function askAgain(run: MergeRun, stream: vscode.ChatResponseStream, baseUrl?: string): Promise<void> {
  const numbered = (labels: string[]) => labels.map((l, i) => `${i + 1}. ${buildChatCommandLink(l, '@jira', String(i + 1))}`).join('\n');
  const stop = buildChatCommandLink('Stop here', '@jira', 'cancel');
  if (run.awaiting === 'target') {
    const group = run.closeGroups?.find(g => g.issueType === run.closeIssueType);
    const keys = group?.tickets.map(t => formatKeyLink(t.key, baseUrl)).join(', ') ?? '';
    stream.markdown(trustedChatMarkdown(
      `Which status should the **${safeMarkdownText(run.closeIssueType ?? '')}** tickets ${keys} move to?` +
      `${run.duplicateResolution ? ` They are closed with resolution ${safeMarkdownText(run.duplicateResolution)}.` : ''}\n\n` +
      `${numbered((run.closeTargetOptions ?? []).map(formatStaleTargetOption))}\n\nReply with the name or number, or ${stop} to leave them open.`,
    ));
  } else if (run.awaiting === 'resolution') {
    stream.markdown(trustedChatMarkdown(
      `This project has no Duplicate resolution. Which resolution should the tickets get?\n\n${numbered(run.resolutionOptions ?? [])}\n\n` +
      `Reply with the name or number, ${buildChatCommandLink('None', '@jira', 'none')} for no resolution, or ${stop}.`,
    ));
  } else {
    const failed = run.steps.find(s => s.status === 'failed');
    stream.markdown(trustedChatMarkdown(
      `### Merge stopped at one step\n\n${ticketLines(run, baseUrl).join('\n')}\n\n` +
      `${failed ? `**${STEP_LABEL[failed.kind]}** failed for ${formatKeyLink(failed.key, baseUrl)}: ${safeMarkdownText(failed.error ?? '')}\n\n` : ''}` +
      `${buildChatCommandLink('Retry', '@jira', 'retry')} runs it again. ${buildChatCommandLink('Ignore', '@jira', 'ignore')} skips it and carries on with the rest. ${stop} ends the merge here.`,
    ));
  }
}

/** The closes: reads each source, groups the open ones by issue type, and asks the target status of the next group. */
async function closePhase<TItem, TRow extends ReviewRowBase>(
  session: ReviewSession<TRow>,
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
  descriptor: ReportImportDescriptor<TItem, TRow>,
  baseUrl?: string,
): Promise<MergeTurn> {
  const run = session.mergeRun!;
  const closes = run.steps.filter(s => s.kind === 'close' && s.status === 'pending');
  if (closes.length === 0) return finish(session, stream, descriptor, baseUrl);

  if (!run.closeGroups) {
    const details = new Map<string, { summary: string; currentStatus: string; issueType: string }>();
    const open: Array<{ key: string; ids: string[] }> = [];
    for (const step of closes) {
      try {
        const issue = await ticketService.getIssue(step.key);
        if (issue.fields.resolution != null) {
          step.status = 'done';
          step.note = 'already resolved';
          continue;
        }
        details.set(step.key, { summary: issue.fields.summary ?? '', currentStatus: issue.fields.status?.name ?? '', issueType: issue.fields.issuetype?.name ?? '' });
        open.push({ key: step.key, ids: [] });
      } catch (err) {
        return failStep(step, err, run, stream, descriptor, baseUrl);
      }
    }
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    let built: Awaited<ReturnType<typeof buildStaleTicketGroups>>;
    try {
      built = await buildStaleTicketGroups(open, details, session.projectKey, { getResolutions: () => ticketService.getResolutions() }, workspaceRoot, descriptor.scope);
    } catch (err) {
      const step = closes.find(s => s.status === 'pending')!;
      return failStep(step, err, run, stream, descriptor, baseUrl);
    }
    for (const t of built.ineligible) {
      const step = stepOf(run, 'close', t.key)!;
      step.status = 'skipped';
      step.note = t.note;
      run.closeSkipped = [...(run.closeSkipped ?? []), { key: t.key, reason: t.note }];
    }
    run.closeGroups = built.groups.map(g => ({ ...g, tickets: g.tickets.map(t => ({ ...t, included: true })) }));
    run.resolutionOptions = built.resolutionOptions;
    run.duplicateResolution = built.resolutionOptions.find(r => r.toLowerCase() === 'duplicate');
  }

  for (const group of run.closeGroups) {
    const pending = group.tickets.filter(t => stepOf(run, 'close', t.key)?.status === 'pending');
    if (pending.length === 0) continue;
    const options = buildStaleTargetOptions(group.rules, group.graph, pending.map(t => t.currentStatus));
    if (options.length === 0) {
      for (const t of pending) {
        const step = stepOf(run, 'close', t.key)!;
        step.status = 'skipped';
        step.note = `no status of the discovered ${group.issueType} workflow can be reached from ${t.currentStatus}`;
      }
      continue;
    }
    run.closeIssueType = group.issueType;
    run.closeTargetOptions = options;
    run.closeTarget = undefined;
    run.awaiting = 'target';
    await askAgain(run, stream, baseUrl);
    return 'waiting';
  }
  return finish(session, stream, descriptor, baseUrl);
}

function stepOf(run: MergeRun, kind: MergeStep['kind'], key: string): MergeStep | undefined {
  return run.steps.find(s => s.kind === kind && s.key === key);
}

/** Closes the group being asked about at the picked status, then goes on to the next group. */
async function closeGroup<TItem, TRow extends ReviewRowBase>(
  session: ReviewSession<TRow>,
  resolution: string | undefined,
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
  descriptor: ReportImportDescriptor<TItem, TRow>,
  baseUrl?: string,
): Promise<MergeTurn> {
  const run = session.mergeRun!;
  const group: StaleTicketGroup = run.closeGroups!.find(g => g.issueType === run.closeIssueType)!;
  const targetState = staleTargetState(run.closeTarget!);
  const settled = run.steps.filter(s => s.kind === 'close' && s.status !== 'pending').map(s => s.key);
  const { runnable, skipped } = planStaleTransitions(group, targetState, settled);
  run.awaiting = undefined;

  for (const s of skipped) {
    const step = stepOf(run, 'close', s.key)!;
    const alreadyThere = group.tickets.find(t => t.key === s.key)?.currentStatus.toLowerCase() === targetState.toLowerCase();
    step.status = alreadyThere ? 'done' : 'skipped';
    step.note = s.reason;
    if (!alreadyThere) run.closeSkipped = [...(run.closeSkipped ?? []), { key: s.key, reason: s.reason }];
  }
  stream.markdown(`_Closing ${runnable.length} ticket(s) as **${safeMarkdownText(targetState)}**${resolution ? ` with resolution ${safeMarkdownText(resolution)}` : ''}…_\n\n`);
  const result = runnable.length > 0
    ? await transitionTickets(runnable, ticketService, resolution, descriptor.scope)
    : { failures: [] as Array<{ key: string; reason: string }> };
  const failures = new Map(result.failures.map(f => [f.key, f.reason]));
  for (const t of runnable) {
    const step = stepOf(run, 'close', t.key)!;
    if (failures.has(t.key)) {
      step.status = 'failed';
      step.error = failures.get(t.key);
      continue;
    }
    step.status = 'done';
    if (resolution) {
      // transitionAlongPath retries without the resolution when Jira rejects the field, so read the ticket back.
      try {
        const actual = (await ticketService.getIssue(t.key)).fields.resolution?.name;
        if (actual !== resolution) step.note = `closed without resolution ${resolution}${actual ? ` (it has ${actual})` : ''}`;
      } catch { /* the close itself succeeded; a failed read-back is not a failed close */ }
    }
  }
  if (run.steps.some(s => s.status === 'failed')) {
    run.awaiting = 'decision';
    await askAgain(run, stream, baseUrl);
    return 'waiting';
  }
  return closePhase(session, ticketService, stream, descriptor, baseUrl);
}

/** The end of a run: marks the rows, counts the outcome, streams the report and clears the run. */
function finish<TItem, TRow extends ReviewRowBase>(
  session: ReviewSession<TRow>,
  stream: vscode.ChatResponseStream,
  descriptor: ReportImportDescriptor<TItem, TRow>,
  baseUrl?: string,
): MergeTurn {
  const run = session.mergeRun!;
  const done = (kind: MergeStep['kind'], key: string) => stepOf(run, kind, key)?.status === 'done';
  const mergedSources = run.sources.filter(key => done('source-rewrite', key));
  const closedSources = run.sources.filter(key => done('close', key));
  const survivorRewritten = done('survivor-rewrite', run.survivor);

  const mark = (r: TRow): TRow => {
    if (r.existingTicketKey === null || isTicketedRowFinished(r)) return r;
    const key = ticketedTargetKey(r);
    if (mergedSources.includes(key)) return { ...r, result: { status: 'done', action: 'merge', into: run.survivor } };
    if (key === run.survivor && survivorRewritten) return { ...r, result: { status: 'done', action: 'rewrite' } };
    return r;
  };
  session.allRows = session.allRows.map(mark);
  session.rows = session.rows.map(mark);
  const outcomes = session.outcomes ?? emptyImportOutcomes();
  session.outcomes = { ...outcomes, merged: outcomes.merged + closedSources.length, mergeFailed: outcomes.mergeFailed + (run.sources.length - closedSources.length) };

  const missing = run.steps.filter(s => s.status === 'skipped' || s.status === 'failed');
  const closedWithout = run.steps.filter(s => s.kind === 'close' && s.note?.startsWith('closed without'));
  const heading = missing.length === 0 && closedWithout.length === 0 ? '### Merge finished' : '### Merge finished with gaps';
  stream.markdown(trustedChatMarkdown(
    `${heading}\n\n${ticketLines(run, baseUrl).join('\n')}` +
    `${missing.length > 0 ? `\n\nStill missing: ${missing.map(s => `${STEP_LABEL[s.kind]} (${formatKeyLink(s.key, baseUrl)})`).join(', ')}. Fix these in Jira by hand.` : ''}` +
    `${run.closeSkipped?.some(s => /workflow/i.test(s.reason)) ? '\n\nIf a ticket could not be closed for lack of a workflow, run `@jira discover workflow` and close it from the Stale screen or in Jira.' : ''}\n\n`,
  ));
  logDiag(descriptor.scope, missing.length > 0 ? 'warn' : 'info', `${descriptor.importLabel} import — merge finished`, {
    survivor: run.survivor, sources: run.sources, closed: closedSources.length, missing: missing.length,
  });
  // The screens no longer match Jira when a step is missing or a ticket was closed without its resolution; the next refresh is the user's.
  if (missing.length > 0 || closedWithout.length > 0) session.outOfDate = true;
  session.mergeRun = undefined;
  return 'finished';
}
