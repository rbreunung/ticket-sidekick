// Report import: merging tickets (`merge <sources> into <survivor>`; Waltz rewrites, Veracode closes), streamed to chat — the
// confirmation, the questions the run waits on and the final report. The run itself lives in src/imports/merge.ts, which the
// import board shares; this file words it.
import * as vscode from 'vscode';
import { formatKeyLink, type TicketService } from '../../services/TicketService';
import {
  buildChatCommandLink, buildCloseMergePrompt, buildMergePrompt, formatStaleTargetOption, parseMergeRunReply, safeMarkdownText,
  type MergeRun, type MergeStep, type ReviewRowBase, type ReviewSession,
} from '../sessionState';
import { trustedChatMarkdown } from '../../utils/chatMarkdown';
import {
  pickMergeResolution, pickMergeTarget, prepareMergePrompt, resumeMerge, startMergeRun, stopMerge,
  type MergeContext, type MergeProgress, type MergeReport,
} from '../../imports/merge';
import { diagOf } from './importCreate';
import type { ReportImportDescriptor } from './reportImportTypes';

/** What a call leaves behind: a question is waiting (the session must be saved), the run is over, or the reply was refused with nothing started. */
export type MergeTurn = 'waiting' | 'finished' | 'refused';

function mergeContext<TItem, TRow extends ReviewRowBase>(
  stream: vscode.ChatResponseStream,
  descriptor: ReportImportDescriptor<TItem, TRow>,
  baseUrl?: string,
): MergeContext {
  return {
    workspaceRoot: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '',
    baseUrl,
    onDiag: diagOf(descriptor),
    onEvent: closing => stream.markdown(`_Closing ${closing.count} ticket(s) as **${safeMarkdownText(closing.targetState)}**${closing.resolution ? ` with resolution ${safeMarkdownText(closing.resolution)}` : ''}…_\n\n`),
  };
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
  const prompt = await prepareMergePrompt(session, sourceRefs, targetRef, ticketService, descriptor, diagOf(descriptor));
  if (prompt.kind === 'refused') {
    stream.markdown(`_Nothing was written. ${safeMarkdownText(prompt.reason)}_\n\n`);
    return 'refused';
  }
  if (prompt.kind === 'read-failed') {
    stream.markdown(`✗ Could not read all the tickets, so nothing was written: ${safeMarkdownText(prompt.error)}\n\n`);
    return 'refused';
  }
  if (prompt.kind === 'close') {
    const { kind: _kind, ...input } = prompt;
    stream.markdown(trustedChatMarkdown(buildCloseMergePrompt({ ...input, baseUrl })));
  } else {
    const { kind: _kind, ...input } = prompt;
    stream.markdown(trustedChatMarkdown(buildMergePrompt({ ...input, baseUrl })));
  }
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
  const started = await startMergeRun(session, sourceRefs, targetRef, ticketService, descriptor, mergeContext(stream, descriptor, baseUrl));
  if (started.kind === 'refused') {
    stream.markdown(`_Nothing was written. ${safeMarkdownText(started.reason)}_\n\n`);
    return 'refused';
  }
  if (started.kind === 'read-failed') {
    stream.markdown(`✗ Could not read all the tickets, so nothing was written: ${safeMarkdownText(started.error)}\n\n`);
    return 'refused';
  }
  return streamProgress(started.progress, session, stream, baseUrl);
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
  const ctx = mergeContext(stream, descriptor, baseUrl);
  switch (parsed.kind) {
    case 'invalid':
      stream.markdown("_Didn't understand that — answer the question below._\n\n");
      askAgain(run, stream, baseUrl);
      return 'waiting';
    case 'cancel':
      stream.markdown('_Merge stopped here. Steps already done stay as they are._\n\n');
      return streamProgress(stopMerge(session, descriptor, ctx.onDiag), session, stream, baseUrl);
    case 'retry':
    case 'ignore':
      return streamProgress(await resumeMerge(session, parsed.kind, ticketService, descriptor, ctx), session, stream, baseUrl);
    case 'target':
      return streamProgress(await pickMergeTarget(session, parsed.option, ticketService, descriptor, ctx), session, stream, baseUrl);
    case 'resolution':
      return streamProgress(await pickMergeResolution(session, parsed.resolution, ticketService, descriptor, ctx), session, stream, baseUrl);
  }
}

/** Waiting: asks the question the run waits on. Finished: streams the final report. */
function streamProgress<TRow extends ReviewRowBase>(
  progress: MergeProgress,
  session: ReviewSession<TRow>,
  stream: vscode.ChatResponseStream,
  baseUrl?: string,
): MergeTurn {
  if (progress.turn === 'waiting') {
    askAgain(session.mergeRun!, stream, baseUrl);
    return 'waiting';
  }
  streamReport(progress.report, stream, baseUrl);
  return 'finished';
}

const STEP_LABEL: Record<MergeStep['kind'], string> = {
  'survivor-rewrite': 'rewrite the kept ticket',
  'survivor-comment': 'comment on the kept ticket',
  link: 'link the tickets',
  'source-rewrite': 'mark the ticket as merged',
  'source-comment': 'comment on the closed ticket',
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
    ...run.sources.flatMap(key => [`**${formatKeyLink(key, baseUrl)}** (closing)`, ...forKey(key).map(l => `  - ${l}`)]),
  ];
}

/** Re-states the question the run is waiting on: the failure with retry and ignore, the target status, or the resolution. */
function askAgain(run: MergeRun, stream: vscode.ChatResponseStream, baseUrl?: string): void {
  const numbered = (labels: string[]) => labels.map((l, i) => `${i + 1}. ${buildChatCommandLink(l, '@jira', String(i + 1))}`).join('\n');
  const stop = buildChatCommandLink('Stop here', '@jira', 'cancel');
  if (run.awaiting === 'target') {
    const group = run.closeGroups?.find(g => g.issueType === run.closeIssueType);
    const keys = group?.tickets.map(t => formatKeyLink(t.key, baseUrl)).join(', ') ?? '';
    stream.markdown(trustedChatMarkdown(
      `Move ${keys} (${safeMarkdownText(run.closeIssueType ?? '')}) to which status?` +
      `${run.duplicateResolution ? ` It is closed with resolution ${safeMarkdownText(run.duplicateResolution)}.` : ''}\n\n` +
      `${numbered((run.closeTargetOptions ?? []).map(formatStaleTargetOption))}\n\nReply with a number or name, or ${stop} to leave it open.`,
    ));
  } else if (run.awaiting === 'resolution') {
    stream.markdown(trustedChatMarkdown(
      `No Duplicate resolution in this project. Pick one:\n\n${numbered(run.resolutionOptions ?? [])}\n\n` +
      `Reply with a number or name, ${buildChatCommandLink('None', '@jira', 'none')} for no resolution, or ${stop}.`,
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

/** The end of a run: the step-by-step state of every ticket and what is still missing. */
function streamReport(report: MergeReport, stream: vscode.ChatResponseStream, baseUrl?: string): void {
  const { run, missing, closedWithout } = report;
  const heading = missing.length === 0 && closedWithout.length === 0 ? '### Merge finished' : '### Merge finished with gaps';
  stream.markdown(trustedChatMarkdown(
    `${heading}\n\n${ticketLines(run, baseUrl).join('\n')}` +
    `${missing.length > 0 ? `\n\nStill missing: ${missing.map(s => `${STEP_LABEL[s.kind]} (${formatKeyLink(s.key, baseUrl)})`).join(', ')}. Fix these in Jira by hand.` : ''}` +
    `${run.closeSkipped?.some(s => /workflow/i.test(s.reason)) ? '\n\nIf a ticket could not be closed for lack of a workflow, type `/ts-jira workflow <KEY>` with its key and close it from the Stale screen or in Jira.' : ''}\n\n`,
  ));
}
