// Report import: the Stale screen's close action — the stepped issue-type / target / resolution ask and
// the transition batch (stale-ticket target pick plan).
import * as vscode from 'vscode';
import { logDiag } from '../../utils/diagLog';
import type { TicketService } from '../../services/TicketService';
import { CURRENT_SESSION_SCHEMA_VERSION, buildChatCommandLink, buildStaleTargetOptions, emptyImportOutcomes, ensureImportViewState, formatStaleTargetOption, isBackOrCancellation, parseResolutionSelection, parseStaleIssueTypePick, parseStaleTargetPick, planStaleTransitions, selectedOpenStaleTickets, selectedStaleIssueTypes, staleTargetNeedsResolution, staleTargetState, type ReviewRowBase, type ReviewSession, type StaleCloseSession, type StaleTargetOption, type VeracodeReviewSession, type WaltzReviewSession } from '../sessionState';
import { STALE_RESOLUTION_SESSION_KEY, sessionWasSuperseded } from './ticketContext';
import { transitionTickets } from './cleanupHandler';
import { trustedChatMarkdown } from '../../utils/chatMarkdown';
import { afterGroupAction, streamImportReview } from './importReviewScreen';
import type { ReportImportDescriptor } from './reportImportTypes';

/**
 * Streams the current step of the stepped stale close (stale-ticket target pick plan, KTD4): which
 * issue type to close (R12), which target (R1/R2), or which resolution (R4). Every choice is a
 * clickable reply, plus `Back` to the Stale screen with nothing transitioned (R5).
 */
export async function streamStaleCloseStep(
  close: StaleCloseSession,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
  note?: string,
): Promise<vscode.ChatResult> {
  await ws.update(STALE_RESOLUTION_SESSION_KEY, close);
  const numbered = (labels: string[]) => labels.map((l, i) => `${i + 1}. ${buildChatCommandLink(l, '@jira', String(i + 1))}`).join('\n');
  const back = `${buildChatCommandLink('Back', '@jira', 'back')} to return to the stale tickets without transitioning any`;
  const prefix = note ? `${note}\n\n` : '';
  let body: string;
  if (close.step === 'pick-issue-type') {
    body = 'The selected stale tickets span several issue types, and each run closes one. Which issue type do you want to close now?\n\n' +
      `${numbered(close.issueTypeOptions)}\n\nReply with the name or number, or ${back}.`;
  } else if (close.step === 'pick-target') {
    const selected = selectedCount(close);
    body = `Where should the **${selected}** selected stale **${close.issueType}** ticket(s) go?\n\n` +
      `${numbered(close.targetOptions!.map(formatStaleTargetOption))}\n\n` +
      `Cleanup rules (listed first) apply their own resolution. Reply with the name or number, or ${back}.`;
  } else {
    const options = close.reviewSession.staleTickets?.resolutionOptions ?? [];
    body = `The tickets will move to **${staleTargetState(close.target!)}** — which resolution should be set?\n\n${numbered(options)}\n\n` +
      `Reply with the name or number, ${buildChatCommandLink('None', '@jira', 'none')} to skip setting a resolution, or ${back}.`;
  }
  stream.markdown(trustedChatMarkdown(prefix + body));
  return { metadata: { jiraSession: { kinds: ['stale-resolution-selection'] } } };
}

function selectedCount(close: StaleCloseSession): number {
  const stale = close.reviewSession.staleTickets;
  const group = stale?.groups.find(g => g.issueType === close.issueType);
  return group ? selectedOpenStaleTickets(group, stale!.closedKeys).length : 0;
}

/**
 * Continues the stepped stale close with the user's reply to the current step: moves to the next
 * step, re-shows the same step on an unrecognized reply, returns to the Stale screen on `back`/
 * cancel (R5), or — once the target (and any resolution) is known — runs the transitions for the
 * chosen issue type and returns to the Stale screen or overview (KTD6).
 */
export async function continueStaleClose<TItem, TRow extends ReviewRowBase>(
  reply: string,
  close: StaleCloseSession,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
  descriptor: ReportImportDescriptor<TItem, TRow>,
  ticketService: TicketService,
  baseUrl?: string,
): Promise<vscode.ChatResult | void> {
  // A second, independent import may have started (and claimed the template-selection session key)
  // while this question was open.
  if (sessionWasSuperseded(ws, descriptor.sessionKeys.templateSelection)) {
    await ws.update(STALE_RESOLUTION_SESSION_KEY, undefined);
    stream.markdown('_A newer import was started while this one was waiting for an answer — cancelled to avoid transitioning tickets from a stale batch._');
    return;
  }

  const parked = ensureImportViewState(close.reviewSession as unknown as ReviewSession<TRow>);
  const backToStale = async () => {
    await ws.update(STALE_RESOLUTION_SESSION_KEY, undefined);
    stream.markdown('_No stale tickets were transitioned._\n\n');
    return streamImportReview({ ...parked, view: 'stale' }, stream, ws, descriptor, baseUrl);
  };
  const invalid = "_Didn't understand that — pick one of the options below._";

  if (close.step === 'pick-issue-type') {
    const pick = parseStaleIssueTypePick(reply, close.issueTypeOptions);
    if (pick === 'back') return backToStale();
    if (pick === 'invalid') return streamStaleCloseStep(close, stream, ws, invalid);
    return startTargetPick(pick, parked, close.issueTypeOptions, stream, ws, descriptor, baseUrl);
  }

  if (close.step === 'pick-target') {
    const pick = parseStaleTargetPick(reply, close.targetOptions ?? []);
    if (pick === 'back') return backToStale();
    if (pick === 'invalid') return streamStaleCloseStep(close, stream, ws, invalid);
    if (staleTargetNeedsResolution(pick, parked.staleTickets?.resolutionOptions ?? [])) {
      return streamStaleCloseStep({ ...close, step: 'pick-resolution', target: pick }, stream, ws);
    }
    await ws.update(STALE_RESOLUTION_SESSION_KEY, undefined);
    const resolution = pick.kind === 'rule' ? pick.resolution : undefined;
    return finishStaleClose(parked, close.issueType!, pick, resolution, ticketService, stream, ws, descriptor, baseUrl);
  }

  // pick-resolution: a resolution name (even "Cancelled") and "none"/"skip" (no resolution) are
  // matched before back/cancel words, which only go back when nothing else matched.
  const choice = parseResolutionSelection(reply, parked.staleTickets?.resolutionOptions ?? []);
  if (choice === 'invalid') {
    return isBackOrCancellation(reply) ? backToStale() : streamStaleCloseStep(close, stream, ws, invalid);
  }
  await ws.update(STALE_RESOLUTION_SESSION_KEY, undefined);
  return finishStaleClose(parked, close.issueType!, close.target!, choice ?? undefined, ticketService, stream, ws, descriptor, baseUrl);
}

async function startTargetPick<TItem, TRow extends ReviewRowBase>(
  issueType: string,
  session: ReviewSession<TRow>,
  issueTypeOptions: string[],
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
  descriptor: ReportImportDescriptor<TItem, TRow>,
  baseUrl?: string,
): Promise<vscode.ChatResult> {
  const stale = session.staleTickets!;
  const group = stale.groups.find(g => g.issueType === issueType)!;
  const selectedStatuses = selectedOpenStaleTickets(group, stale.closedKeys).map(t => t.currentStatus);
  const targetOptions = buildStaleTargetOptions(group.rules, group.graph, selectedStatuses);
  if (targetOptions.length === 0) {
    // Plan review fix: an empty pick list would strand the user on a question with nothing to pick.
    await ws.update(STALE_RESOLUTION_SESSION_KEY, undefined);
    stream.markdown(
      `_The selected **${issueType}** tickets can't reach any status in the discovered workflow, and no cleanup rule matches. ` +
      `Run \`@jira discover workflow ${session.projectKey} ${issueType}\` to refresh the workflow cache. No stale tickets were transitioned._\n\n`,
    );
    return streamImportReview({ ...session, view: 'stale' }, stream, ws, descriptor, baseUrl);
  }
  const close: StaleCloseSession = {
    descriptorKind: descriptor.descriptorKind as 'veracode' | 'waltz',
    step: 'pick-target',
    issueTypeOptions,
    issueType,
    targetOptions,
    reviewSession: session as unknown as VeracodeReviewSession | WaltzReviewSession,
    schemaVersion: CURRENT_SESSION_SCHEMA_VERSION,
  };
  return streamStaleCloseStep(close, stream, ws);
}

async function finishStaleClose<TItem, TRow extends ReviewRowBase>(
  session: ReviewSession<TRow>,
  issueType: string,
  target: StaleTargetOption,
  resolution: string | undefined,
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
  descriptor: ReportImportDescriptor<TItem, TRow>,
  baseUrl?: string,
): Promise<vscode.ChatResult> {
  const updated = await runStaleTransitions(session, issueType, staleTargetState(target), resolution, ticketService, stream, descriptor);
  // KTD6: while tickets of another issue type are still selected, stay on the Stale screen.
  const next = selectedStaleIssueTypes(updated.staleTickets!).length > 0 ? { ...updated, view: 'stale' as const } : afterGroupAction(updated);
  return streamImportReview(next, stream, ws, descriptor, baseUrl);
}

/**
 * "close tickets" on the Stale screen (stale-ticket target pick plan, R1/R12): with nothing
 * selected, says so; with several issue types selected, asks which one to close now; otherwise
 * goes straight to the target pick for the one selected issue type. Nothing transitions until the
 * target (and any resolution) is picked.
 */
export async function closeStaleTickets<TItem, TRow extends ReviewRowBase>(
  session: ReviewSession<TRow>,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
  descriptor: ReportImportDescriptor<TItem, TRow>,
  baseUrl?: string,
): Promise<vscode.ChatResult | void> {
  const issueTypes = session.staleTickets ? selectedStaleIssueTypes(session.staleTickets) : [];
  if (issueTypes.length === 0) {
    stream.markdown('_Nothing selected — no stale tickets were closed._\n\n');
    return streamImportReview(session, stream, ws, descriptor, baseUrl);
  }
  await ws.update(descriptor.sessionKeys.review, session);
  if (issueTypes.length > 1) {
    const close: StaleCloseSession = {
      descriptorKind: descriptor.descriptorKind as 'veracode' | 'waltz',
      step: 'pick-issue-type',
      issueTypeOptions: issueTypes,
      reviewSession: session as unknown as VeracodeReviewSession | WaltzReviewSession,
      schemaVersion: CURRENT_SESSION_SCHEMA_VERSION,
    };
    return streamStaleCloseStep(close, stream, ws);
  }
  return startTargetPick(issueTypes[0], session, issueTypes, stream, ws, descriptor, baseUrl);
}

/**
 * Transitions the chosen issue type's selected, not-yet-transitioned stale tickets to `targetState`
 * through cleanupHandler.ts's shared `transitionTickets()`, with paths computed from the group's
 * stored workflow graph (KTD2). A ticket already there or with no path is skipped with a note and
 * deselected (R11); transitioned tickets are marked so they are never transitioned again.
 */
async function runStaleTransitions<TItem, TRow extends ReviewRowBase>(
  session: ReviewSession<TRow>,
  issueType: string,
  targetState: string,
  resolution: string | undefined,
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
  descriptor: ReportImportDescriptor<TItem, TRow>,
): Promise<ReviewSession<TRow>> {
  const stale = session.staleTickets;
  const group = stale?.groups.find(g => g.issueType === issueType);
  if (!stale || !group) return session;
  const closed = stale.closedKeys ?? [];
  const { runnable, skipped } = planStaleTransitions(group, targetState, closed);
  stream.markdown(`_Transitioning ${runnable.length} stale **${issueType}** ticket(s) to **${targetState}**…_\n\n`);

  const result = runnable.length > 0
    ? await transitionTickets(runnable, ticketService, resolution, descriptor.scope)
    : { failures: [] as Array<{ key: string; reason: string }> };
  const failedKeys = new Set(result.failures.map(f => f.key));
  const newlyClosed = runnable.filter(t => !failedKeys.has(t.key)).map(t => t.key);
  const failedTickets = runnable.length - newlyClosed.length;

  let summary = `**${newlyClosed.length}** stale ticket(s) transitioned to **${targetState}**, ${failedTickets} failed` +
    (skipped.length > 0 ? `, ${skipped.length} skipped.` : '.');
  if (skipped.length > 0) summary += '\n\n' + skipped.map(s => `– ${s.key} skipped — ${s.reason}`).join('\n');
  if (result.failures.length > 0) {
    summary += '\n\n' + result.failures.map(f => `✗ ${f.key} — ${f.reason}`).join('\n');
    summary += '\n\nIf caused by a workflow gap, run `@jira discover workflow` to refresh the cache.';
  }
  stream.markdown(`${summary}\n\n`);
  logDiag(descriptor.scope, result.failures.length > 0 ? 'warn' : 'info',
    `${descriptor.importLabel} stale-ticket close — ${newlyClosed.length} transitioned to ${targetState}, ${failedTickets} failed, ${skipped.length} skipped`,
    { issueType, targetState, transitioned: newlyClosed.length, failed: failedTickets, skipped: skipped.length },
  );

  const skippedKeys = new Set(skipped.map(s => s.key));
  const outcomes = session.outcomes ?? emptyImportOutcomes();
  return {
    ...session,
    staleTickets: {
      ...stale,
      groups: stale.groups.map(g => (g !== group ? g : {
        ...g,
        tickets: g.tickets.map(t => (skippedKeys.has(t.key) ? { ...t, included: false } : t)),
      })),
      closedKeys: [...closed, ...newlyClosed],
    },
    outcomes: { ...outcomes, closed: outcomes.closed + newlyClosed.length, closeFailed: outcomes.closeFailed + failedTickets },
  };
}
