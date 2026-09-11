import * as vscode from 'vscode';
import { JiraApiClient } from '../jira/JiraApiClient';
import { ConfigService } from '../services/ConfigService';
import { TicketService, renderFieldValue, formatKeyLink, PartialTransitionError } from '../services/TicketService';
import type { IJiraClient, JiraFieldMeta, JiraFilter, JiraSprintCandidate } from '../jira/IJiraClient';
import { TemplateService } from '../templates/TemplateService';
import type { JiraTemplate } from '../templates/TemplateService';
import { tokenStatus } from '../utils/diagUtils';
import { logDiag } from '../utils/diagLog';
import { type CreationSession, type ContentSession, type MoreCommentsSession, type CreateSelectionSession, type TransitionBatchSession, type TransitionBatchTicket, type TransitionSubtask, type ResolutionSelectionSession, type CommentListSession, type FilterSelectionSession, type SearchResultSession, type BulkUpdateReviewSession, type BulkUpdateReviewRow, type FieldUpdatePreviewSession, type FieldSelectionSession, type SprintSelectionSession, type LoadSkippedSession, type JiraFollowupState, type JiraSessionKind, isConfirmation, isCancellation, isGreetingOrEmpty, computeJiraFollowups, pickEmailOption, parseSkipInput, applyTicketToggle, parseResolutionSelection, buildCommentListSession, parseCommentIndex, formatCommentsInFull, parseFilterSelection, parseBulkUpdateReview, applyBulkUpdateToggle, parseSkippedAttachmentSelection, rewriteAttachmentLinks, buildTeamJql, buildBulkUpdateReviewMessage } from './sessionState';
import {
  type GuidedTransitionSession,
  buildGuidedTransitionStatusOptions, parseGuidedTransitionStatusPick, findGuidedDirectTransition,
  parseGuidedTransitionPathPick, formatTransitionPathOption, parseGuidedTransitionResolutionPick,
  buildGuidedTransitionConfirmSummary, extractProjectKeyFromTicketKey, formatPartialTransitionFailure,
} from './sessionState';
import { findPath, findAllPaths, loadWorkflowCache, resolveAndApplyTransition, findRepresentativeTicket } from '../services/WorkflowService';
import type { CachedTransition, WorkflowGraph } from '../services/WorkflowService';
import type { CleanupRule } from '../templates/TemplateService';
import type { Operation, ParsedIntent } from './jira/llmHelpers';
import { parseIntent, extractFixVersionFromPrompt, generateContent, isLmRefusal, synthesizeComments, generateDescriptionAndCommentsSummary, isPointerPrompt, extractLastAssistantText, mapCommandToOperation } from './jira/llmHelpers';
import { streamFieldUpdatePreview, continueSetField, handleSetField, handleSpellCheck } from './jira/fieldHandler';
import { getActiveJiraSession, resolveTicketFromBranch, resolveProjectKey, resolveIssueTypeOrPrompt, parseLastTicketFromContext, sessionWasSuperseded } from './jira/ticketContext';
import { validateBaseUrl } from '../services/configValidation';
import { gatherFileContent, buildContentContext, streamContentPreview, handleContentSession } from './jira/contentHandler';
import { streamCreateSelection, continueAfterIssueType, streamNextSection, finishTicketCreation, handleCreateTicket } from './jira/createHandler';
import { serializeCommentsForLLM, handleLoadTicket, attachmentsDirFor } from './jira/loadHandler';
import { formatFileSize } from '../utils/attachmentEligibility';
import { streamReviewScreen, executeCleanupBatch, handleRunCleanup, extractExtraFields } from './jira/cleanupHandler';
import { handleDiscoverWorkflow } from './jira/workflowHandler';
import {
  handleCreateFromEmail, handleAddEmailFromChat, handleEmailContentSession,
  handleEmailTemplateSelection, handleEmailReviewReply,
} from './jira/emailHandler';
import type { EmailContentSession, EmailTemplateSelectionSession, EmailReviewSession } from './sessionState';
import {
  handleImportVeracodeReport, handleVeracodeTemplateSelection, handleVeracodeReviewReply,
} from './jira/veracodeHandler';
import type { VeracodeTemplateSelectionSession, VeracodeReviewSession } from './sessionState';
import { isSessionExpired, SESSION_EXPIRED_MESSAGE } from './sessionState';
import {
  handleImportWaltzReport, handleWaltzTemplateSelection, handleWaltzReviewReply,
} from './jira/waltzHandler';
import type { WaltzTemplateSelectionSession, WaltzReviewSession } from './sessionState';
import {
  TEMPLATE_GEN_SESSION_KEYS, TEMPLATE_GEN_KINDS,
  handleGenerateTemplate, handleAwaitNameReply, handleTypePickReply, handleAwaitFreeTypeReply,
  handleTemplateGenReviewReply, handleTemplateGenCollisionReply, handleOfferCreateReply, handleAwaitSummaryReply,
} from './jira/templateGenerationHandler';
import type {
  TemplateGenerationAwaitNameSession, TemplateGenerationTypePickSession, TemplateGenerationAwaitFreeTypeSession,
  TemplateGenerationReviewSession, TemplateGenerationCollisionSession,
  TemplateGenerationOfferCreateSession, TemplateGenerationAwaitSummarySession,
} from './sessionState';
import { AWAIT_ISSUE_TYPE_SESSION_KEY } from './jira/ticketContext';
import { parseAwaitFreeTextReply, type AwaitIssueTypeSession, buildChatCommandLink, neutralizeMarkdownLinks, withLastTicket } from './sessionState';
import { trustedChatMarkdown } from '../utils/chatMarkdown';
import { handleVeracodeAwaitIssueType } from './jira/veracodeHandler';
import { handleWaltzAwaitIssueType } from './jira/waltzHandler';
import { handleEmailAwaitIssueType } from './jira/emailHandler';

// Shared by the combined template/issue-type selection block and the R6/KTD4 issue-type
// chat-ask's 'create' resume branch — both need to re-look-up a picked template by name (a
// template may have been renamed or removed since it was picked) before calling
// continueAfterIssueType. Returns null when no name was picked, no workspace is open, or the
// template is no longer found (warning already streamed in that case).
async function resolveTemplateByName(name: string | null, stream: vscode.ChatResponseStream): Promise<JiraTemplate | null> {
  if (!name) return null;
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  if (!workspaceRoot) return null;
  let found: JiraTemplate | null = null;
  try {
    const { templates } = new TemplateService(workspaceRoot).loadTemplates();
    found = templates.find((t) => t.name === name) ?? null;
  } catch (err) {
    logDiag('jira.participant', 'warn', `Could not reload template — ${name}`, {
      templateName: name, error: err instanceof Error ? err.message : String(err),
    });
  }
  if (!found) {
    stream.markdown(`_Warning: template "${name}" is no longer available — proceeding without its default fields._\n\n`);
  }
  return found;
}

// Shared by the three comment-listing sites (getTicket / showComments / getComments) that offer to
// load older comments. Returns a trusted MarkdownString so the embedded "load all" command link is
// live — callers stream it directly via `stream.markdown(...)`.
function olderCommentsNotShownLink(count: number): vscode.MarkdownString {
  return trustedChatMarkdown(
    `\n\n_${count} older comment(s) not shown. Reply ${buildChatCommandLink('load all', '@jira', 'load all')} to include them._`,
  );
}

// ---------------------------------------------------------------------------------------------
// R2/F1: guided single-ticket transition flow ("Transition it" chip). See GuidedTransitionSession
// in sessionState.ts for the session shape and every pure parsing/formatting helper this uses —
// everything below is the vscode-dependent glue (streaming, workspaceState, live Jira lookups)
// that can't live in that vscode-free file. Mirrors the resolution-selection/filter-selection
// session blocks further down: one workspaceState key, re-rendered on every "didn't understand
// that" retry (KTD6), cleared the moment the flow ends (apply or cancel).
// ---------------------------------------------------------------------------------------------

const GUIDED_TRANSITION_SESSION_KEY = 'jira.session.guidedTransition';

// R5: static, non-clickable prose appended to the greeting and R8-fallback responses — no client
// capability exists to look up a user's actual saved filters, so this stays plain text rather than
// a chip that would need to fabricate a filter name (a failure mode this plan removes elsewhere).
const SAVED_FILTER_TIP =
  '_Tip: if you have a saved Jira filter, try "search from filter \'My open bugs\'" or "search filter 12345"._';

// R13: the same "loadedTicket" follow-up shape the bottom of the main handler attaches to every
// ordinary operation result — reproduced here so the guided flow's own early-return continuations
// (which bypass that shared tail) still leave the user with the usual next-step chips and
// lastTicketKey tracking once the flow ends, instead of silently dropping both.
function guidedTransitionLoadedTicketResult(
  ticketKey: string,
  projectKey: string,
  issueType: string,
): { metadata: Record<string, unknown> } {
  const followupState: JiraFollowupState = { kind: 'loadedTicket', ticketKey, projectKey, issueType, justDid: 'transition' };
  return { metadata: { jiraFollowup: followupState, ...withLastTicket(ticketKey).metadata } };
}

async function streamGuidedTransitionStatusPick(
  session: GuidedTransitionSession,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
  invalid = false,
): Promise<vscode.ChatResult> {
  await ws.update(GUIDED_TRANSITION_SESSION_KEY, session);
  const list = session.statusOptions.map((s, i) => `${i + 1}. ${buildChatCommandLink(s, '@jira', String(i + 1))}`).join('\n');
  const prefix = invalid ? "Didn't understand that. " : '';
  stream.markdown(trustedChatMarkdown(
    `${prefix}**${session.ticketKey}** is currently in **${session.currentStatus}**. Which status should it move to?\n\n${list}\n\n` +
    `Reply with the number or name, or ${buildChatCommandLink('Cancel', '@jira', 'cancel')}.`,
  ));
  return { metadata: { jiraSession: { kinds: ['guided-transition'] } } };
}

async function streamGuidedTransitionResolutionPick(
  session: GuidedTransitionSession,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
  invalid = false,
): Promise<vscode.ChatResult> {
  await ws.update(GUIDED_TRANSITION_SESSION_KEY, session);
  const options = session.resolutionOptions ?? [];
  const list = options.map((r, i) => `${i + 1}. ${buildChatCommandLink(r, '@jira', String(i + 1))}`).join('\n');
  const prefix = invalid ? "Didn't understand that. " : '';
  stream.markdown(trustedChatMarkdown(
    `${prefix}Moving **${session.ticketKey}** to **${session.targetStatus}** requires a resolution. Which one?\n\n${list}\n\n` +
    `Reply with the name or number, or ${buildChatCommandLink('Cancel', '@jira', 'cancel')}.`,
  ));
  return { metadata: { jiraSession: { kinds: ['guided-transition'] } } };
}

async function streamGuidedTransitionPathPick(
  session: GuidedTransitionSession,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
  invalid = false,
): Promise<vscode.ChatResult> {
  await ws.update(GUIDED_TRANSITION_SESSION_KEY, session);
  const paths = session.pathOptions ?? [];
  const list = paths
    .map((p, i) => `${i + 1}. ${buildChatCommandLink(formatTransitionPathOption(session.currentStatus, p), '@jira', String(i + 1))}`)
    .join('\n');
  const prefix = invalid ? "Didn't understand that. " : '';
  stream.markdown(trustedChatMarkdown(
    `${prefix}**${session.targetStatus}** isn't directly reachable from **${session.currentStatus}** — here ` +
    `${paths.length === 1 ? 'is the path' : 'are the paths'} found:\n\n${list}\n\nReply with the number, or ${buildChatCommandLink('Cancel', '@jira', 'cancel')}.`,
  ));
  return { metadata: { jiraSession: { kinds: ['guided-transition'] } } };
}

async function streamGuidedTransitionConfirm(
  session: GuidedTransitionSession,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
  invalid = false,
): Promise<vscode.ChatResult> {
  await ws.update(GUIDED_TRANSITION_SESSION_KEY, session);
  const prefix = invalid ? "Didn't understand that. " : '';
  const summary = buildGuidedTransitionConfirmSummary(
    session.ticketKey, session.targetStatus!, session.resolution, session.chosenPath ?? [], session.currentStatus,
  );
  stream.markdown(trustedChatMarkdown(
    `${prefix}${summary}\n\nReply ${buildChatCommandLink('Yes', '@jira', 'yes')} to apply, or ${buildChatCommandLink('Cancel', '@jira', 'cancel')} to cancel.`,
  ));
  return { metadata: { jiraSession: { kinds: ['guided-transition'] } } };
}

/**
 * R2 step 3's "scoped to the path's final hop's transition metadata": the cached workflow graph
 * (`WorkflowGraph`/`CachedTransition`, `WorkflowService.ts`) only ever stored `id`/`name`/`to` — it
 * never carried `fields.resolution` (U1 added that only to the *live* `getTransitions` response,
 * not the cache format, which is out of scope for this unit — see the report). A multi-hop path's
 * final transition only becomes real once the ticket has actually moved through the earlier hops,
 * so there is no live data for it on the ticket we actually have. This samples one real ticket
 * already sitting in the second-to-last status — via the shared `findRepresentativeTicket` helper
 * `discoverWorkflow` itself uses — and reads *that* ticket's live transitions to find the matching
 * one by name/target. No representative ticket found (or the lookup fails outright) degrades to
 * "not required", matching the plan's own Assumptions section for missing metadata.
 */
async function resolveFinalHopResolution(
  jiraClient: IJiraClient,
  projectKey: string,
  issueType: string,
  path: CachedTransition[],
): Promise<{ required: boolean; allowedValues: string[] }> {
  const notRequired = { required: false, allowedValues: [] };
  if (path.length < 2) return notRequired;
  const finalHop = path[path.length - 1];
  const priorStatus = path[path.length - 2].to;
  try {
    const repKey = await findRepresentativeTicket(jiraClient, projectKey, issueType, priorStatus);
    if (!repKey) return notRequired;
    const liveTransitions = await jiraClient.getTransitions(repKey);
    const match = liveTransitions.find((t) => t.name === finalHop.name && t.to.name === finalHop.to);
    if (!match?.fields?.resolution?.required) return notRequired;
    return { required: true, allowedValues: match.fields.resolution.allowedValues.map((v) => v.name) };
  } catch {
    return notRequired;
  }
}

/**
 * Starts the guided flow (R2/F1) when "Transition it" is clicked with no target status: fetches
 * the ticket's current status and available transitions, builds the status-pick option list
 * (AE1's multi-hop targets included, via any cached workflow graph), and streams the first choice
 * point. A ticket with literally nothing to transition to (no direct transitions and no graph) is
 * told so directly instead of opening a session with an empty picker.
 */
async function startGuidedTransition(
  ticketKey: string,
  jiraClient: IJiraClient,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
  workspaceRoot: string,
): Promise<vscode.ChatResult> {
  const issue = await jiraClient.getIssue(ticketKey);
  const currentStatus = issue.fields.status.name;
  const projectKey = extractProjectKeyFromTicketKey(ticketKey) ?? ticketKey.split('-')[0];
  const issueType = (issue.fields.issuetype as { name?: string } | undefined)?.name ?? '';
  const directTransitions = await jiraClient.getTransitions(ticketKey);
  const graph = loadWorkflowCache(workspaceRoot)[projectKey]?.[issueType]?.graph;
  const statusOptions = buildGuidedTransitionStatusOptions(directTransitions, graph, currentStatus);

  if (statusOptions.length === 0) {
    stream.markdown(`**${ticketKey}** is in **${currentStatus}** and has no available transitions.`);
    return guidedTransitionLoadedTicketResult(ticketKey, projectKey, issueType);
  }

  const session: GuidedTransitionSession = {
    ticketKey, currentStatus, projectKey, issueType, directTransitions, statusOptions, step: 'pick-status',
  };
  return await streamGuidedTransitionStatusPick(session, stream, ws);
}

/**
 * Continues an in-progress guided transition on the user's reply, dispatching on
 * `session.step` — the single entry point the top-of-handler `'guided-transition'` session check
 * calls into. Each step's unmatched-reply case follows KTD6 (re-show that step's options with a
 * "didn't understand that" message, session kept alive); each cancel clears the session and takes
 * no Jira write action (R2's confirm-step guarantee, applied uniformly at every step for the same
 * reason bulk transition's own review screen lets you back out at any point).
 */
async function continueGuidedTransition(
  session: GuidedTransitionSession,
  reply: string,
  jiraClient: IJiraClient,
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
  workspaceRoot: string,
): Promise<vscode.ChatResult | void> {
  const cancel = async () => {
    await ws.update(GUIDED_TRANSITION_SESSION_KEY, undefined);
    stream.markdown('_Cancelled — no changes made._');
  };

  if (session.step === 'pick-status') {
    const pick = parseGuidedTransitionStatusPick(reply, session.statusOptions);
    if (pick === 'cancel') return cancel();
    if (pick === 'invalid') return await streamGuidedTransitionStatusPick(session, stream, ws, true);

    session.targetStatus = pick;
    const direct = findGuidedDirectTransition(session.directTransitions, pick);
    if (direct) {
      session.chosenPath = [{ id: direct.id, name: direct.name, to: direct.to.name }];
      const resolutionMeta = direct.fields?.resolution;
      if (resolutionMeta?.required) {
        session.resolutionOptions = resolutionMeta.allowedValues.map((v) => v.name);
        session.step = 'pick-resolution';
        return await streamGuidedTransitionResolutionPick(session, stream, ws);
      }
      session.step = 'confirm';
      return await streamGuidedTransitionConfirm(session, stream, ws);
    }

    // No direct transition — fall back to the cached workflow graph, exactly like
    // resolveAndApplyTransition's own multi-hop fallback (R3: same source of truth, just
    // enumerating every route instead of only the first one findPath returns).
    const graph = loadWorkflowCache(workspaceRoot)[session.projectKey]?.[session.issueType]?.graph;
    const paths = graph ? findAllPaths(graph, session.currentStatus, pick) : [];
    if (paths.length === 0) {
      await ws.update(GUIDED_TRANSITION_SESSION_KEY, undefined);
      // Reuses resolveAndApplyTransition's own 'unavailable' wording verbatim (the plan's explicit
      // instruction not to invent new copy here) rather than calling it directly — calling it would
      // duplicate the getIssue/getTransitions round trip we've already made in this session.
      const available = session.directTransitions.map((t) => t.to.name);
      const availableText = available.length > 0 ? ` Available: ${available.map((n) => `**${n}**`).join(', ')}.` : '';
      const cacheHint = graph
        ? ''
        : ` Run \`@jira discover workflow ${session.projectKey} ${session.issueType || '<issuetype>'}\` to enable multi-hop transitions.`;
      stream.markdown(`No transition to **${pick}** available from **${session.currentStatus}**.${availableText}${cacheHint}`);
      return guidedTransitionLoadedTicketResult(session.ticketKey, session.projectKey, session.issueType);
    }
    session.pathOptions = paths;
    session.step = 'pick-path';
    return await streamGuidedTransitionPathPick(session, stream, ws);
  }

  if (session.step === 'pick-path') {
    const pick = parseGuidedTransitionPathPick(reply, session.pathOptions?.length ?? 0);
    if (pick === 'cancel') return cancel();
    if (pick === 'invalid') return await streamGuidedTransitionPathPick(session, stream, ws, true);

    const chosen = session.pathOptions![pick - 1];
    session.chosenPath = chosen;
    const finalHopResolution = await resolveFinalHopResolution(jiraClient, session.projectKey, session.issueType, chosen);
    if (finalHopResolution.required) {
      session.resolutionOptions = finalHopResolution.allowedValues;
      session.step = 'pick-resolution';
      return await streamGuidedTransitionResolutionPick(session, stream, ws);
    }
    session.step = 'confirm';
    return await streamGuidedTransitionConfirm(session, stream, ws);
  }

  if (session.step === 'pick-resolution') {
    const pick = parseGuidedTransitionResolutionPick(reply, session.resolutionOptions ?? []);
    if (pick === 'cancel') return cancel();
    if (pick === 'invalid') return await streamGuidedTransitionResolutionPick(session, stream, ws, true);

    session.resolution = pick;
    session.step = 'confirm';
    return await streamGuidedTransitionConfirm(session, stream, ws);
  }

  // session.step === 'confirm'
  if (isCancellation(reply)) return cancel();
  if (!isConfirmation(reply)) return await streamGuidedTransitionConfirm(session, stream, ws, true);

  await ws.update(GUIDED_TRANSITION_SESSION_KEY, undefined);
  try {
    await ticketService.transitionAlongPath(session.ticketKey, session.chosenPath!, session.resolution);
  } catch (err) {
    if (err instanceof PartialTransitionError && err.completedHops > 0) {
      const landedStatus = session.chosenPath![err.completedHops - 1].to;
      stream.markdown(formatPartialTransitionFailure(
        session.ticketKey, landedStatus, err.completedHops, err.totalHops, session.targetStatus!, err.message,
      ));
      return guidedTransitionLoadedTicketResult(session.ticketKey, session.projectKey, session.issueType);
    }
    const message = err instanceof Error ? err.message : String(err);
    logDiag('jira.participant', 'error', message, {});
    stream.markdown(message);
    return guidedTransitionLoadedTicketResult(session.ticketKey, session.projectKey, session.issueType);
  }
  const hops = session.chosenPath!.length;
  stream.markdown(
    hops > 1
      ? `**${session.ticketKey}** moved to **${session.targetStatus}** (${hops} hops).`
      : `**${session.ticketKey}** moved to **${session.targetStatus}**.`,
  );
  return guidedTransitionLoadedTicketResult(session.ticketKey, session.projectKey, session.issueType);
}

export function createJiraParticipant(
  context: vscode.ExtensionContext,
  configService: ConfigService,
): vscode.ChatParticipant {
  // U5/R6: the handler returns `{ metadata: { jiraFollowup } }` from a major response so
  // `participant.followupProvider` below can compute the right suggestion chips for it without
  // re-deriving state from response text — `vscode.ChatResult.metadata` is the VS Code-native
  // channel a chat handler uses to hand its own `followupProvider` this kind of state. A bare
  // `return;` (still valid — `void` stays in the union) means "no chip-worthy state", e.g. a
  // multi-turn session reply whose own response already carries the next-step guidance.
  const handler: vscode.ChatRequestHandler = async (
    request: vscode.ChatRequest,
    chatContext: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
  ): Promise<vscode.ChatResult | void> => {
    const config = await configService.getConfig();

    if (!configService.isConfigured(config)) {
      if (!config.baseUrl) {
        const settingsLink = new vscode.MarkdownString(
          '**Jira base URL not configured.**\n\n' +
          'Add `ticketSidekick.jira.baseUrl` to your VS Code settings (e.g. `https://jira.mycompany.com`), ' +
          `or [open Settings](command:workbench.action.openSettings?${encodeURIComponent(JSON.stringify('ticketSidekick.jira.baseUrl'))}) directly.`,
        );
        settingsLink.isTrusted = { enabledCommands: ['workbench.action.openSettings'] };
        stream.markdown(settingsLink);
        return;
      }

      const setupCommand = config.authType === 'cloud'
        ? 'ticket-sidekick.configureCloud'
        : 'ticket-sidekick.setDataCenterToken';
      const setupLabel = config.authType === 'cloud'
        ? 'Ticket Sidekick: Configure Jira Cloud Credentials'
        : 'Ticket Sidekick: Set Jira Personal Access Token';
      const credentialsLink = new vscode.MarkdownString(
        `**Jira credentials not configured.**\n\nRun [${setupLabel}](command:${setupCommand}) from the chat, or find it in the Command Palette.`,
      );
      credentialsLink.isTrusted = { enabledCommands: [setupCommand] };
      stream.markdown(credentialsLink);
      return;
    }

    const jiraClient = new JiraApiClient({
      baseUrl: config.baseUrl,
      authType: config.authType,
      token: config.token,
      sprintBoardId: config.sprintBoardId,
      onDiag: (level, message, details) => logDiag('jira.apiClient', level, message, details),
    });
    if (config.showConnectionInfo) {
      stream.markdown(`_${config.baseUrl} · API v2 · ${config.authType}_\n\n`);
    }
    const ticketService = new TicketService(
      jiraClient,
      (level, message, details) => logDiag('jira.ticketService', level, message, details),
    );
    const ws = context.workspaceState;

    // U4/R5: `/check` is the slash-command shortcut for this same check — checked
    // before the multi-turn session-tag scan below, exactly like the plain-text
    // "check" phrase already was (KTD12).
    if (request.command === 'check' || /^check(\s+(config|connection|setup))?$/i.test(request.prompt.trim())) {
      const urlError = validateBaseUrl(config.baseUrl);
      if (urlError) {
        stream.markdown(`**Jira configuration problem**\n\n${urlError}`);
        return;
      }
      try {
        const user = await jiraClient.getCurrentUser();
        stream.markdown(
          `**Jira connection OK**\n\n` +
          `| Setting | Value |\n` +
          `|---|---|\n` +
          `| Base URL | \`${config.baseUrl ?? ''}\` |\n` +
          `| API version | v2 |\n` +
          `| Auth type | ${config.authType} |\n` +
          `| Token | ${tokenStatus(config.token)} |\n` +
          `| Logged in as | ${user.displayName} |\n`,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logDiag('jira.participant', 'error', 'Jira connection check failed', { baseUrl: config.baseUrl, authType: config.authType, error: message });
        stream.markdown(
          `**Jira connection failed**\n\n` +
          `| Setting | Value |\n` +
          `|---|---|\n` +
          `| Base URL | \`${config.baseUrl ?? ''}\` |\n` +
          `| API version | v2 |\n` +
          `| Auth type | ${config.authType} |\n` +
          `| Token | ${tokenStatus(config.token)} |\n\n` +
          `Error: ${message}`,
        );
      }
      return;
    }

    // Resolution selection — user replied with a resolution choice before the review screen.
    // Shared by cleanupHandler.ts (bulk-cleanup path) and the bulkTransition production site
    // further below in this file — both now use the metadata-based liveness check (R1/R3).
    if (getActiveJiraSession(chatContext)?.kinds.includes('resolution-selection')) {
      const selSession = ws.get<ResolutionSelectionSession>('jira.session.resolutionSelection');
      if (selSession) {
        const choice = parseResolutionSelection(request.prompt, selSession.resolutionOptions);
        if (choice === 'invalid') {
          const list = selSession.resolutionOptions.map((r, i) => `${i + 1}. ${buildChatCommandLink(r, '@jira', String(i + 1))}`).join('\n');
          stream.markdown(trustedChatMarkdown(
            `Please choose a resolution:\n\n${list}\n\nReply with name or number, or ${buildChatCommandLink('None', '@jira', 'none')} to skip.`,
          ));
          return { metadata: { jiraSession: { kinds: ['resolution-selection'] } } };
        }
        await ws.update('jira.session.resolutionSelection', undefined);
        const batchSession: TransitionBatchSession = {
          tickets: selSession.tickets,
          resolution: choice ?? undefined,
          ruleName: selSession.ruleName,
          issueType: selSession.issueType,
          fieldIds: selSession.fieldIds,
          fieldMeta: selSession.fieldMeta,
        };
        const header = `**Cleanup${selSession.ruleName ? `: ${selSession.ruleName}` : ''}**`;
        return await streamReviewScreen(batchSession, stream, ws, header, config.baseUrl);
      }
    }

    // Transition review — user replied ok/cancel/toggle keys
    if (getActiveJiraSession(chatContext)?.kinds.includes('transition-review')) {
      const session = ws.get<TransitionBatchSession>('jira.session.transitionReview');
      if (session) {
        const result = parseSkipInput(request.prompt, session.tickets);
        const header = `**Cleanup${session.ruleName ? `: ${session.ruleName}` : ''}**`;
        if (result.action === 'invalid') {
          return await streamReviewScreen(session, stream, ws, header, config.baseUrl);
        }
        // R8/AE4: a toggle reply (click or typed numbers) flips included and re-renders — it never
        // executes the batch itself, unlike the pre-U6 one-shot skip-and-run behavior.
        if (result.action === 'toggle') {
          const toggledSession: TransitionBatchSession = {
            ...session,
            tickets: applyTicketToggle(session.tickets, result.keys),
          };
          return await streamReviewScreen(toggledSession, stream, ws, header, config.baseUrl);
        }
        await ws.update('jira.session.transitionReview', undefined);
        if (result.action === 'cancel') {
          stream.markdown('_Cancelled — no tickets were changed._');
          return;
        }
        try {
          await executeCleanupBatch(session, ticketService, stream);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logDiag('jira.participant', 'error', message, {});
          stream.markdown(message);
        }
        return;
      }
    }

    // Guided single-ticket transition (R2/F1) — user replied to the status/resolution/path/confirm
    // choice point the "Transition it" chip opened. See continueGuidedTransition above.
    if (getActiveJiraSession(chatContext)?.kinds.includes('guided-transition')) {
      const session = ws.get<GuidedTransitionSession>(GUIDED_TRANSITION_SESSION_KEY);
      if (session) {
        const guidedWorkspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
        try {
          return await continueGuidedTransition(session, request.prompt, jiraClient, ticketService, stream, ws, guidedWorkspaceRoot);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logDiag('jira.participant', 'error', message, {});
          stream.markdown(message);
        }
        return;
      }
    }

    // Filter selection — user replied with their filter choice
    if (getActiveJiraSession(chatContext)?.kinds.includes('selecting-filter')) {
      const selSession = ws.get<FilterSelectionSession>('jira.session.filterSelection');
      if (selSession) {
        const choice = parseFilterSelection(request.prompt, selSession.filters);
        if (choice === 'invalid') {
          const list = selSession.filters.map((f, i) => `${i + 1}. ${buildChatCommandLink(f.name, '@jira', String(i + 1))}`).join('\n');
          stream.markdown(trustedChatMarkdown(
            `Please choose a filter:\n\n${list}\n\nReply with the number or name, or ${buildChatCommandLink('Cancel', '@jira', 'cancel')}.`,
          ));
          return { metadata: { jiraSession: { kinds: ['selecting-filter'] } } };
        }
        await ws.update('jira.session.filterSelection', undefined);
        if (choice === 'cancel') {
          stream.markdown('_Cancelled._');
          return;
        }
        try {
          const raw = await ticketService.searchTicketsRaw(choice.jql);
          if (raw.issues.length > 0) {
            await ws.update('jira.session.searchResult', { ticketKeys: raw.issues.map(i => i.key), jql: choice.jql } as SearchResultSession);
          }
          const result = await ticketService.searchTickets(choice.jql);
          stream.markdown(`_Using filter: **${choice.name}**_\n\n${result}`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logDiag('jira.participant', 'error', message, {});
          stream.markdown(message);
        }
        return;
      }
    }

    // Combined template/issue-type selection — user replied with their pick
    if (getActiveJiraSession(chatContext)?.kinds.includes('selecting-create-option')) {
      const selSession = ws.get<CreateSelectionSession>('jira.session.creatingSelection');
      if (selSession) {
        if (isCancellation(request.prompt)) {
          await ws.update('jira.session.creatingSelection', undefined);
          stream.markdown('_Cancelled._');
          return;
        }
        const n = parseInt(request.prompt.trim(), 10);
        const pick = isNaN(n) ? null : pickEmailOption(n, selSession.templates, selSession.issueTypes);
        if (!pick) {
          return await streamCreateSelection(selSession, stream, ws);
        }
        await ws.update('jira.session.creatingSelection', undefined);

        const pickedTemplateName = pick.kind === 'template' ? pick.name : null;

        // '' is the "no resolvable issue type" sentinel (see handleCreateTicket) — detour to the
        // shared chat-based ask (R6/KTD4) instead of silently creating the ticket with a guessed
        // type. AwaitIssueTypeResume carries pickedTemplateName (identity, not the resolved
        // object) so the resume path re-looks it up the same way, once the type is known.
        const issueTypeOrResult = await resolveIssueTypeOrPrompt(pick.issueType, {
          kind: 'create', projectKey: selSession.projectKey, summary: selSession.summary,
          description: selSession.description, extraFields: selSession.extraFields, pickedTemplateName,
        }, stream, ws);
        if (typeof issueTypeOrResult !== 'string') return issueTypeOrResult;
        const issueType = issueTypeOrResult;

        // Looked up only now, after the detour check above — on a chat detour this result would
        // be thrown away, and its "no longer available" warning would then repeat a second time
        // on resume (efficiency review).
        const selectedTemplate = await resolveTemplateByName(pickedTemplateName, stream);

        try {
          return await continueAfterIssueType(
            selSession.projectKey, selSession.summary, issueType, selSession.description,
            selectedTemplate, request.model, stream, token, jiraClient, ticketService, ws,
            selSession.extraFields,
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logDiag('jira.participant', 'error', message, {});
          stream.markdown(message);
        }
        return;
      }
    }

    // Shared issue-type chat-ask (R6/KTD4) — every flow that needed an issue type it couldn't
    // otherwise resolve (create, Veracode/Waltz report import, email-to-ticket) resumes here,
    // dispatching on resume.kind to each family's own existing continuation. Lives in
    // JiraParticipant.ts (not ticketContext.ts) because it needs createHandler.ts/
    // reportImportHandler.ts/emailHandler.ts's continuations, all of which already import from
    // ticketContext.ts — this avoids a require cycle while keeping ticketContext.ts a leaf module.
    if (getActiveJiraSession(chatContext)?.kinds.includes('await-issue-type')) {
      const session = ws.get<AwaitIssueTypeSession>(AWAIT_ISSUE_TYPE_SESSION_KEY);
      if (session) {
        if (isSessionExpired(session)) {
          await ws.update(AWAIT_ISSUE_TYPE_SESSION_KEY, undefined);
          stream.markdown(SESSION_EXPIRED_MESSAGE);
          return;
        }

        // KTD3: only an explicit "(c)" cancels here, matching what the ask's own prompt text
        // advertises — same divergence from isCancellation() as R2/R3's asks.
        const parsed = parseAwaitFreeTextReply(request.prompt);
        if (parsed.action === 'cancel') {
          await ws.update(AWAIT_ISSUE_TYPE_SESSION_KEY, undefined);
          stream.markdown('No issue type provided — cancelled.');
          return;
        }
        if (parsed.action === 'empty') {
          // KTD3: this ask's cancel check is isExplicitCancelToken() (literal "(c)"), not
          // isCancellation()'s broader word list — the link resubmits "(c)" itself so the click
          // reproduces exactly what already works, without touching that parser (Risks section).
          stream.markdown(trustedChatMarkdown(
            `What issue type should this use (e.g. Bug, Story, Task)?\n\nReply with a type, or ${buildChatCommandLink('Cancel', '@jira', '(c)')}.`,
          ));
          return { metadata: { jiraSession: { kinds: ['await-issue-type'] } } };
        }

        await ws.update(AWAIT_ISSUE_TYPE_SESSION_KEY, undefined);
        const issueType = parsed.value;
        const { resume } = session;
        let awaitResult: vscode.ChatResult | void = undefined;
        try {
          if (resume.kind === 'create') {
            // Mirrors the sibling branches' sessionWasSuperseded() guard — a second @jira create
            // started while this one awaited its issue type must not resume on stale data (plan's
            // own U4 test scenario). 'jira.session.creatingSelection' is the key the combined
            // template/issue-type selection block above clears right before this detour; the rare
            // createHandler.ts NO_ISSUE_TYPE fallback (no prior selection session) finds it
            // undefined here and proceeds normally.
            if (sessionWasSuperseded(ws, 'jira.session.creatingSelection')) {
              stream.markdown('_A newer create was started while this one was waiting for the issue type — cancelled to avoid creating a stale ticket._');
              return;
            }
            const selectedTemplate = await resolveTemplateByName(resume.pickedTemplateName, stream);
            awaitResult = await continueAfterIssueType(
              resume.projectKey, resume.summary, issueType, resume.description,
              selectedTemplate, request.model, stream, token, jiraClient, ticketService, ws,
              resume.extraFields,
            );
          } else if (resume.descriptorKind === 'veracode') {
            awaitResult = await handleVeracodeAwaitIssueType(resume, issueType, jiraClient, ticketService, stream, ws, config.baseUrl);
          } else if (resume.descriptorKind === 'waltz') {
            awaitResult = await handleWaltzAwaitIssueType(resume, issueType, jiraClient, ticketService, stream, ws, config.baseUrl);
          } else {
            awaitResult = await handleEmailAwaitIssueType(resume, issueType, jiraClient, ticketService, stream, ws, config.baseUrl);
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logDiag('jira.participant', 'error', message, {});
          stream.markdown(message);
        }
        return awaitResult;
      }
    }

    // Creation session continuation — user answered a section prompt
    if (getActiveJiraSession(chatContext)?.kinds.includes('creating')) {
      const session = ws.get<CreationSession>('jira.session.creating');
      if (session) {
        try {
          const justAnswered = session.pending[0];
          if (justAnswered === '__summary__') {
            session.summary = request.prompt;
          } else {
            session.answers[justAnswered] = request.prompt;
          }
          session.pending = session.pending.slice(1);
          if (session.pending.length === 0) {
            await ws.update('jira.session.creating', undefined);
            return await finishTicketCreation(session, stream, ws);
          } else {
            return await streamNextSection(session, stream, ws);
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logDiag('jira.participant', 'error', message, {});
          stream.markdown(message);
        }
        return;
      }
    }

    // Content session — comment/description preview awaiting confirm/refine
    if (getActiveJiraSession(chatContext)?.kinds.includes('previewing')) {
      const session = ws.get<ContentSession>('jira.session.previewing');
      if (session) {
        try {
          return await handleContentSession(session, request.prompt, request.model, token, stream, ticketService, ws, config.baseUrl);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logDiag('jira.participant', 'error', message, {});
          stream.markdown(message);
        }
        return;
      }
    }

    // Sprint selection — user replied with their sprint choice
    if (getActiveJiraSession(chatContext)?.kinds.includes('sprint-selection')) {
      const sprintSession = ws.get<SprintSelectionSession>('jira.session.sprintSelection');
      if (sprintSession) {
        const trimmed = request.prompt.trim();
        if (/^(c|cancel)$/i.test(trimmed)) {
          await ws.update('jira.session.sprintSelection', undefined);
          stream.markdown('_Cancelled._');
          return;
        }
        const idx = parseInt(trimmed, 10);
        if (isNaN(idx) || idx < 1 || idx > sprintSession.candidates.length) {
          const list = sprintSession.candidates.map((s, i) =>
            `${i + 1}. ${buildChatCommandLink(`${s.name} (${s.state})`, '@jira', String(i + 1))}`,
          ).join('\n');
          stream.markdown(trustedChatMarkdown(
            `Please reply with a number (1–${sprintSession.candidates.length}):\n\n${list}\n\n` +
            `or ${buildChatCommandLink('Cancel', '@jira', 'cancel')}.`,
          ));
          return { metadata: { jiraSession: { kinds: ['sprint-selection'] } } };
        }
        await ws.update('jira.session.sprintSelection', undefined);
        const chosen = sprintSession.candidates[idx - 1];
        if (sprintSession.pending.kind === 'field-update') {
          const preview: FieldUpdatePreviewSession = {
            ...sprintSession.pending.session,
            fieldValue: chosen.id,
          };
          return await streamFieldUpdatePreview(preview, stream, ws);
        }
        return;
      }
    }

    // Field selection — user replied with their field choice
    if (getActiveJiraSession(chatContext)?.kinds.includes('field-selection')) {
      const fieldSelSession = ws.get<FieldSelectionSession>('jira.session.fieldSelection');
      if (fieldSelSession) {
        const trimmed = request.prompt.trim();
        if (/^(c|cancel)$/i.test(trimmed)) {
          await ws.update('jira.session.fieldSelection', undefined);
          stream.markdown('_Cancelled._');
          return;
        }
        const idx = parseInt(trimmed, 10);
        const chosen = (!isNaN(idx) && idx >= 1 && idx <= fieldSelSession.candidates.length)
          ? fieldSelSession.candidates[idx - 1]
          : fieldSelSession.candidates.find(f => f.name.toLowerCase() === trimmed.toLowerCase());
        if (!chosen) {
          const list = fieldSelSession.candidates.map((f, i) =>
            `${i + 1}. ${buildChatCommandLink(`${f.name} (\`${f.id}\`)`, '@jira', String(i + 1))}`,
          ).join('\n');
          stream.markdown(trustedChatMarkdown(
            `Please reply with a number:\n\n${list}\n\nor ${buildChatCommandLink('Cancel', '@jira', 'cancel')}.`,
          ));
          return { metadata: { jiraSession: { kinds: ['field-selection'] } } };
        }
        await ws.update('jira.session.fieldSelection', undefined);
        const { fieldValue, arrayOp, ticketKeys } = fieldSelSession.pending;
        try {
          return await continueSetField(ticketKeys, chosen, fieldValue, arrayOp, ticketService, stream, ws, request.model, token);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logDiag('jira.participant', 'error', message, {});
          stream.markdown(message);
        }
        return;
      }
    }

    // Field update preview — user replied ok / cancel
    if (getActiveJiraSession(chatContext)?.kinds.includes('field-update-preview')) {
      const previewSession = ws.get<FieldUpdatePreviewSession>('jira.session.fieldUpdatePreview');
      if (previewSession) {
        if (isCancellation(request.prompt)) {
          await ws.update('jira.session.fieldUpdatePreview', undefined);
          stream.markdown('_Cancelled._');
          return;
        }
        if (isConfirmation(request.prompt)) {
          await ws.update('jira.session.fieldUpdatePreview', undefined);
          const toUpdate = previewSession.ticketKeys;
          let lastUpdatedKey: string | undefined;
          if (toUpdate.length === 1) {
            try {
              await jiraClient.updateIssue(toUpdate[0], { [previewSession.fieldId]: previewSession.fieldValue });
              stream.markdown(`Updated **${previewSession.fieldName}** on ${formatKeyLink(toUpdate[0], config.baseUrl)}.`);
              // R13: carry the updated ticket key on metadata instead of a visible marker.
              return withLastTicket(toUpdate[0]);
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              logDiag('jira.participant', 'error', message, {});
              stream.markdown(message);
            }
          } else {
            let passed = 0, failed = 0;
            await ticketService.bulkUpdateField(toUpdate, previewSession.fieldId, previewSession.fieldValue, (key, ok, err) => {
              const keyRef = formatKeyLink(key, config.baseUrl);
              if (ok) { stream.markdown(`✓ ${keyRef}\n\n`); passed++; lastUpdatedKey = key; }
              else { stream.markdown(`✗ ${keyRef}: ${err}\n\n`); failed++; }
            });
            stream.markdown(`\n_Done — ${passed} updated${failed > 0 ? `, ${failed} failed` : ''}_`);
          }
          // R13: carry the last successfully updated key on metadata (parity with the
          // single-key path above) so a bare follow-up after a multi-ticket update resolves.
          if (lastUpdatedKey !== undefined) {
            return withLastTicket(lastUpdatedKey);
          }
          return;
        }
        // Not ok or cancel — re-present
        stream.markdown(trustedChatMarkdown(
          `Please reply ${buildChatCommandLink('Post it', '@jira', 'post it')} to apply, or ${buildChatCommandLink('Cancel', '@jira', 'cancel')}.`,
        ));
        await ws.update('jira.session.fieldUpdatePreview', previewSession);
        return { metadata: { jiraSession: { kinds: ['field-update-preview'] } } };
      }
    }

    // More-comments session — user confirmed "load all". Fully self-contained in
    // JiraParticipant.ts (both this resume branch and every production site further below), so
    // this is the metadata-based liveness check (R1/R3) rather than the visible tag.
    if (getActiveJiraSession(chatContext)?.kinds.includes('more-comments') && isConfirmation(request.prompt)) {
      const session = ws.get<MoreCommentsSession>('jira.session.moreComments');
      if (session) {
        try {
          await ws.update('jira.session.moreComments', undefined);
          const { comments } = await ticketService.getIssueComments(session.ticketKey, 100);
          if (session.displayMode === 'full') {
            await ws.update('jira.session.commentList', buildCommentListSession(session.ticketKey, comments));
            stream.markdown(formatCommentsInFull(comments));
            // R13: carry the ticket key on metadata instead of a visible marker.
            return withLastTicket(session.ticketKey, ['comment-list']);
          } else {
            const synthesis = await synthesizeComments(
              serializeCommentsForLLM(comments),
              session.commentQuery,
              request.model,
              token,
            );
            if (!session.commentQuery) {
              await ws.update('jira.session.commentList', buildCommentListSession(session.ticketKey, comments));
            }
            stream.markdown(synthesis);
            // R13: carry the ticket key on metadata instead of a visible marker. With a query the
            // comment list isn't started (empty kinds) but the key is still carried for last-ticket.
            return withLastTicket(session.ticketKey, session.commentQuery ? [] : ['comment-list']);
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logDiag('jira.participant', 'error', message, {});
          stream.markdown(message);
        }
        return;
      }
    }

    // Load skipped — user replied with a number (or "download N") to download skipped
    // attachments. Fully self-contained in JiraParticipant.ts — metadata-based (R1/R3).
    if (getActiveJiraSession(chatContext)?.kinds.includes('load-skipped')) {
      const loadSkippedSession = ws.get<LoadSkippedSession>('jira.session.loadSkipped');
      if (loadSkippedSession) {
        const selection = parseSkippedAttachmentSelection(request.prompt, loadSkippedSession.skipped.length);
        const skippedList = (items: LoadSkippedSession['skipped']) => items
          .map((s, i) => `${i + 1}. ${buildChatCommandLink(`\`${s.filename}\` — ${formatFileSize(s.size)} (${s.mimeType}) — ${s.reason}`, '@jira', String(i + 1))}`)
          .join('\n');
        if (selection === 'not-a-selection') {
          await ws.update('jira.session.loadSkipped', undefined);
          // fall through to intent parsing
        } else if (selection === 'out-of-range') {
          stream.markdown(trustedChatMarkdown(
            `Please reply with a number:\n\n${skippedList(loadSkippedSession.skipped)}\n\nReply with a number to download it anyway.`,
          ));
          return { metadata: { jiraSession: { kinds: ['load-skipped'] } } };
        } else {
          const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
          if (!workspaceFolder) {
            await ws.update('jira.session.loadSkipped', undefined);
            stream.markdown('No workspace folder is open.');
            return;
          }
          const attachmentsDir = attachmentsDirFor(workspaceFolder.uri, loadSkippedSession.ticketKey);
          const lines: string[] = [];
          const downloadedSet = new Set(selection.map(i => i - 1));
          for (const i of selection) {
            const chosen = loadSkippedSession.skipped[i - 1];
            try {
              stream.markdown(`_Downloading \`${chosen.filename}\`…_\n\n`);
              const bytes = await ticketService.downloadAttachment(chosen.content);
              await vscode.workspace.fs.createDirectory(attachmentsDir);
              await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(attachmentsDir, chosen.filename), bytes);
              // Code-review fix: these lines are joined into a trustedChatMarkdown()-wrapped
              // response below (unlike the plain "_Downloading..._" progress line above), so the
              // attachment filename and any error text must be neutralized the same way
              // skippedList's buildChatCommandLink label already is.
              lines.push(`✓ \`${neutralizeMarkdownLinks(chosen.filename)}\` downloaded.`);
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              logDiag('jira.participant', 'warn', `Attachment download failed — ${chosen.filename}`, { fileName: chosen.filename, error: message });
              downloadedSet.delete(i - 1);
              lines.push(`✗ Failed to download \`${neutralizeMarkdownLinks(chosen.filename)}\`: ${neutralizeMarkdownLinks(message)}`);
            }
          }
          const remaining = loadSkippedSession.skipped.filter((_, i) => !downloadedSet.has(i));
          if (remaining.length > 0) {
            await ws.update('jira.session.loadSkipped', { ticketKey: loadSkippedSession.ticketKey, skipped: remaining } satisfies LoadSkippedSession);
            stream.markdown(trustedChatMarkdown(
              `${lines.join('\n')}\n\n**Remaining skipped attachments:**\n\n${skippedList(remaining)}\n\n` +
              `Reply with a number to download another.`,
            ));
            // R13: carry the ticket key on metadata instead of a visible marker.
            return withLastTicket(loadSkippedSession.ticketKey, ['load-skipped']);
          } else {
            await ws.update('jira.session.loadSkipped', undefined);
            stream.markdown(`${lines.join('\n')}\n\nAll attachments saved.`);
            // R13: carry the ticket key on metadata instead of a visible marker.
            return withLastTicket(loadSkippedSession.ticketKey);
          }
        }
      }
    }

    // Bulk update review — user replied ok / skip keys / cancel. Only when no explicit slash
    // command was typed this turn: an ordinary reply like "skip PROJ-1 PROJ-2" is meant for this
    // session, but a real `/comment`/`/field`/etc. command whose leftover prompt text happens to
    // start with a generic word this parser recognizes (e.g. "skip") is an unambiguous signal
    // the user meant a new operation, not a continuation reply — the session itself is left
    // untouched, so it's still there to resume on the next ordinary-text turn.
    if (!request.command && getActiveJiraSession(chatContext)?.kinds.includes('bulk-update-review')) {
      const bulkSession = ws.get<BulkUpdateReviewSession>('jira.session.bulkUpdateReview');
      if (bulkSession) {
        const decision = parseBulkUpdateReview(request.prompt);
        if (decision.action === 'invalid') {
          stream.markdown(trustedChatMarkdown(
            `Didn't understand that. Reply ${buildChatCommandLink('Post it', '@jira', 'post it')} to apply, ` +
            `${buildChatCommandLink('Cancel', '@jira', 'cancel')} to cancel, or \`skip KEY1 KEY2\` to toggle specific tickets.`,
          ));
          return { metadata: { jiraSession: { kinds: ['bulk-update-review'] } } };
        }
        // R8/AE4: a toggle reply (click or typed keys) flips included and re-renders — it never
        // runs the update itself, unlike the pre-U6 one-shot skip-and-run behavior.
        if (decision.action === 'toggle') {
          const toggledRows = applyBulkUpdateToggle(bulkSession.rows, decision.keys);
          const toggledSession: BulkUpdateReviewSession = { ...bulkSession, rows: toggledRows };
          await ws.update('jira.session.bulkUpdateReview', toggledSession);
          stream.markdown(trustedChatMarkdown(buildBulkUpdateReviewMessage(bulkSession.headerLine, toggledRows)));
          return { metadata: { jiraSession: { kinds: ['bulk-update-review'] } } };
        }
        await ws.update('jira.session.bulkUpdateReview', undefined);
        if (decision.action === 'cancel') {
          stream.markdown('_Cancelled — no tickets were changed._');
          return;
        }
        const toUpdate = bulkSession.rows.filter(r => r.included).map(r => r.key);
        stream.markdown(`Updating **${bulkSession.fieldName}** on ${toUpdate.length} ticket(s)…\n\n`);
        let passed = 0;
        let failed = 0;
        await ticketService.bulkUpdateField(toUpdate, bulkSession.fieldId, bulkSession.fieldValue, (key, ok, err) => {
          if (ok) { stream.markdown(`✓ ${key}\n\n`); passed++; }
          else { stream.markdown(`✗ ${key}: ${err}\n\n`); failed++; }
        });
        stream.markdown(`\n_Done — ${passed} updated${failed > 0 ? `, ${failed} failed` : ''}_`);
        return;
      }
    }

    // Email content session — user is confirming/posting an email-as-comment (the only remaining
    // ticket-key-present flow; batch ticket creation routes through the email-template/email-review
    // sessions below instead).
    if (getActiveJiraSession(chatContext)?.kinds.includes('email-content')) {
      const contentSession = ws.get<EmailContentSession>('jira.session.emailContent');
      if (contentSession) {
        return await handleEmailContentSession(request.prompt, contentSession, ticketService, stream, ws);
      }
    }

    // Batch email import — template/issue-type selection
    if (getActiveJiraSession(chatContext)?.kinds.includes('email-template')) {
      const templateSession = ws.get<EmailTemplateSelectionSession>('jira.session.emailTemplateSelection');
      if (templateSession) {
        if (isSessionExpired(templateSession)) {
          await ws.update('jira.session.emailTemplateSelection', undefined);
          stream.markdown(SESSION_EXPIRED_MESSAGE);
          return;
        }
        return await handleEmailTemplateSelection(request.prompt, templateSession, jiraClient, ticketService, stream, ws, config.baseUrl);
      }
    }

    // Batch email import — review / selection screen
    if (getActiveJiraSession(chatContext)?.kinds.includes('email-review')) {
      const reviewSession = ws.get<EmailReviewSession>('jira.session.emailReview');
      if (reviewSession) {
        if (isSessionExpired(reviewSession)) {
          await ws.update('jira.session.emailReview', undefined);
          stream.markdown(SESSION_EXPIRED_MESSAGE);
          return;
        }
        return await handleEmailReviewReply(request.prompt, reviewSession, ticketService, stream, ws, config.baseUrl);
      }
    }

    // Veracode template/issue-type selection
    if (getActiveJiraSession(chatContext)?.kinds.includes('veracode-template')) {
      const templateSession = ws.get<VeracodeTemplateSelectionSession>('jira.session.veracodeTemplateSelection');
      if (templateSession) {
        if (isSessionExpired(templateSession)) {
          await ws.update('jira.session.veracodeTemplateSelection', undefined);
          stream.markdown(SESSION_EXPIRED_MESSAGE);
          return;
        }
        return await handleVeracodeTemplateSelection(request.prompt, templateSession, jiraClient, ticketService, stream, ws, config.baseUrl);
      }
    }

    // Veracode flaw review / selection screen
    if (getActiveJiraSession(chatContext)?.kinds.includes('veracode-review')) {
      const reviewSession = ws.get<VeracodeReviewSession>('jira.session.veracodeReview');
      if (reviewSession) {
        if (isSessionExpired(reviewSession)) {
          await ws.update('jira.session.veracodeReview', undefined);
          stream.markdown(SESSION_EXPIRED_MESSAGE);
          return;
        }
        return await handleVeracodeReviewReply(request.prompt, reviewSession, ticketService, stream, ws, config.baseUrl);
      }
    }

    // Waltz OSS report template/issue-type selection
    if (getActiveJiraSession(chatContext)?.kinds.includes('waltz-template')) {
      const templateSession = ws.get<WaltzTemplateSelectionSession>('jira.session.waltzTemplateSelection');
      if (templateSession) {
        if (isSessionExpired(templateSession)) {
          await ws.update('jira.session.waltzTemplateSelection', undefined);
          stream.markdown(SESSION_EXPIRED_MESSAGE);
          return;
        }
        return await handleWaltzTemplateSelection(request.prompt, templateSession, jiraClient, ticketService, stream, ws, config.baseUrl);
      }
    }

    // Waltz OSS report review / selection screen
    if (getActiveJiraSession(chatContext)?.kinds.includes('waltz-review')) {
      const reviewSession = ws.get<WaltzReviewSession>('jira.session.waltzReview');
      if (reviewSession) {
        if (isSessionExpired(reviewSession)) {
          await ws.update('jira.session.waltzReview', undefined);
          stream.markdown(SESSION_EXPIRED_MESSAGE);
          return;
        }
        return await handleWaltzReviewReply(request.prompt, reviewSession, ticketService, stream, ws, config.baseUrl);
      }
    }

    // Template generation — chat-ask for the template name (R2, no showInputBox)
    if (getActiveJiraSession(chatContext)?.kinds.includes(TEMPLATE_GEN_KINDS.awaitName)) {
      const session = ws.get<TemplateGenerationAwaitNameSession>(TEMPLATE_GEN_SESSION_KEYS.awaitName);
      if (session) {
        const templateGenWorkspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
        return await handleAwaitNameReply(request.prompt, session, ticketService, templateGenWorkspaceRoot, config.hiddenDisplayFields, stream, ws);
      }
    }

    // Template generation — issue-type pick list (no-reference path, no type named)
    if (getActiveJiraSession(chatContext)?.kinds.includes(TEMPLATE_GEN_KINDS.typePick)) {
      const session = ws.get<TemplateGenerationTypePickSession>(TEMPLATE_GEN_SESSION_KEYS.typePick);
      if (session) {
        return await handleTypePickReply(request.prompt, session, ticketService, stream, ws);
      }
    }

    // Template generation — chat-ask for a free-text issue type when the list couldn't be
    // fetched (R3, no showInputBox)
    if (getActiveJiraSession(chatContext)?.kinds.includes(TEMPLATE_GEN_KINDS.awaitFreeType)) {
      const session = ws.get<TemplateGenerationAwaitFreeTypeSession>(TEMPLATE_GEN_SESSION_KEYS.awaitFreeType);
      if (session) {
        return await handleAwaitFreeTypeReply(request.prompt, session, ticketService, stream, ws);
      }
    }

    // Template generation — review list (toggle / setValue / confirm)
    if (getActiveJiraSession(chatContext)?.kinds.includes(TEMPLATE_GEN_KINDS.review)) {
      const session = ws.get<TemplateGenerationReviewSession>(TEMPLATE_GEN_SESSION_KEYS.review);
      if (session) {
        const templateGenWorkspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
        return await handleTemplateGenReviewReply(request.prompt, session, templateGenWorkspaceRoot, stream, ws);
      }
    }

    // Template generation — name-collision handling
    if (getActiveJiraSession(chatContext)?.kinds.includes(TEMPLATE_GEN_KINDS.collision)) {
      const session = ws.get<TemplateGenerationCollisionSession>(TEMPLATE_GEN_SESSION_KEYS.collision);
      if (session) {
        const templateGenWorkspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
        return await handleTemplateGenCollisionReply(request.prompt, session, templateGenWorkspaceRoot, stream, ws);
      }
    }

    // Template generation — offer to create a first ticket from the saved template
    if (getActiveJiraSession(chatContext)?.kinds.includes(TEMPLATE_GEN_KINDS.offerCreate)) {
      const session = ws.get<TemplateGenerationOfferCreateSession>(TEMPLATE_GEN_SESSION_KEYS.offerCreate);
      if (session) {
        return await handleOfferCreateReply(request.prompt, session, ticketService, stream, ws, config.baseUrl);
      }
    }

    // Template generation — awaiting the summary for the first ticket
    if (getActiveJiraSession(chatContext)?.kinds.includes(TEMPLATE_GEN_KINDS.awaitSummary)) {
      const session = ws.get<TemplateGenerationAwaitSummarySession>(TEMPLATE_GEN_SESSION_KEYS.awaitSummary);
      if (session) {
        return await handleAwaitSummaryReply(request.prompt, session, ticketService, stream, ws, config.baseUrl);
      }
    }

    // Comment list — user replied with a comment number to view in full. Fully self-contained
    // in JiraParticipant.ts — metadata-based (R1/R3).
    if (getActiveJiraSession(chatContext)?.kinds.includes('comment-list')) {
      const commentSession = ws.get<CommentListSession>('jira.session.commentList');
      if (commentSession) {
        const index = parseCommentIndex(request.prompt, commentSession.comments.length);
        if (index !== 'invalid') {
          const entry = commentSession.comments[index - 1];
          stream.markdown(`**Comment ${index}** — ${entry.author} (${entry.date})\n\n${entry.bodyMarkdown}`);
          // R13: carry the ticket key on metadata instead of a visible marker.
          return withLastTicket(commentSession.ticketKey, ['comment-list']);
        }
        // Not a comment index — fall through to intent parse
      }
    }

    // U5/R9: an empty invocation or an obvious greeting/help-shaped prompt is detected before
    // it's ever handed to the LLM intent parser — but only after every multi-turn session-tag
    // branch above has already had its chance to claim the turn (same ordering rule U4's
    // command override follows: a session in flight always wins), and only when no `/command`
    // was used (an explicit slash command is never ambiguous, so it skips this check entirely).
    if (!request.command && isGreetingOrEmpty(request.prompt)) {
      stream.markdown(
        '**@jira** manages Jira tickets in natural language — create, view, comment, update ' +
        'fields, transition, and search. Tell me what you need, or try one of the suggestions ' +
        'below.\n\n' + SAVED_FILTER_TIP,
      );
      // R4/AE3: never fabricate a placeholder ticket key — the third chip only appears when the
      // current branch actually resolves to one.
      const greetingState: JiraFollowupState = { kind: 'greeting', branchKey: resolveTicketFromBranch() ?? undefined };
      return { metadata: { jiraFollowup: greetingState } };
    }

    let intent: ParsedIntent;
    try {
      intent = await parseIntent(request.prompt, request.model, token);
      // U4/R5: every other slash command (create/view/comment/field/move/search) routes
      // through this same NL-intent-parsed pipeline, just with its operation pre-decided
      // instead of left to the LLM's classification — parseIntent above still supplies
      // every other field from the prompt text after the command. Every session-tag
      // branch above already returned by this point, so an in-flight multi-turn session
      // always claims the turn before a stray slash command ever could (KTD12).
      const commandOperation = mapCommandToOperation(request.command);
      if (commandOperation) {
        intent = { ...intent, operation: commandOperation };
      }
      if (intent.operation === 'runCleanup') {
        const fv = extractFixVersionFromPrompt(request.prompt);
        if (fv) intent = { ...intent, fixVersion: fv };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logDiag('jira.participant', 'error', 'Could not understand the request (intent parsing failed)', { error: message });
      stream.markdown(`Could not understand the request: ${message}`);
      return;
    }

    // createTicket has its own multi-turn flow
    if (intent.operation === 'createTicket') {
      try {
        return await handleCreateTicket(request, stream, token, jiraClient, ticketService, ws);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logDiag('jira.participant', 'error', message, {});
        stream.markdown(message);
      }
      return;
    }

    if (intent.operation === 'discoverWorkflow') {
      try {
        await handleDiscoverWorkflow(intent, stream, jiraClient);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logDiag('jira.participant', 'error', message, {});
        stream.markdown(message);
      }
      return;
    }

    if (intent.operation === 'runCleanup') {
      try {
        const cleanupFieldMeta = config.cleanupFields.length > 0 ? await ticketService.getFieldMeta() : [];
        return await handleRunCleanup(intent, stream, jiraClient, ticketService, ws, config.baseUrl, config.cleanupFields, cleanupFieldMeta);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logDiag('jira.participant', 'error', message, {});
        stream.markdown(message);
      }
      return;
    }

    if (intent.operation === 'createFromEmail') {
      return await handleCreateFromEmail(request, stream, token, jiraClient, ticketService, configService, ws);
    }

    if (intent.operation === 'addEmailComment') {
      return await handleAddEmailFromChat(request, stream, token, jiraClient, ticketService, configService, ws);
    }

    if (intent.operation === 'importVeracode') {
      return await handleImportVeracodeReport(request, stream, token, jiraClient, ticketService, ws, intent.projectKey);
    }

    if (intent.operation === 'importWaltzReport') {
      return await handleImportWaltzReport(request, stream, token, jiraClient, ticketService, ws, intent.projectKey);
    }

    if (intent.operation === 'generateTemplate') {
      const templateGenWorkspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
      try {
        return await handleGenerateTemplate(stream, ws, ticketService, templateGenWorkspaceRoot, config.hiddenDisplayFields, {
          templateName: intent.templateName,
          sourceTicketKey: intent.ticketKey,
          projectKeyHint: intent.projectKey,
          issueTypeHint: intent.issueType,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logDiag('jira.participant', 'error', message, {});
        stream.markdown(message);
      }
      return;
    }

    let ticketKey = intent.ticketKey;
    if (!ticketKey && intent.operation !== 'searchJql' && intent.operation !== 'bulkTransition' && intent.operation !== 'bulkUpdateField') {
      ticketKey = resolveTicketFromBranch();
      if (ticketKey) {
        stream.markdown(`_Using ticket **${ticketKey}** from current branch._\n\n`);
      } else {
        ticketKey = parseLastTicketFromContext(chatContext);
        if (ticketKey) {
          stream.markdown(`_Using last referenced ticket **${ticketKey}**._\n\n`);
        } else {
          stream.markdown('Which ticket are you referring to? (e.g. `@jira show me PROJ-123`)');
          return;
        }
      }
    }

    try {
      let result: string;
      switch (intent.operation) {
        case 'getTicket': {
          const fieldMeta = await ticketService.getFieldMeta();
          const alwaysShowIds = new Set<string>(config.additionalDisplayFields);
          const hiddenIds = new Set<string>(config.hiddenDisplayFields);
          const base = await ticketService.getTicket(ticketKey!, fieldMeta, alwaysShowIds, hiddenIds, config.baseUrl);
          const MAX_SHOW = 20;
          const { comments, total } = await ticketService.getIssueComments(ticketKey!, MAX_SHOW);
          if (comments.length > 0) {
            const synthesis = await synthesizeComments(
              serializeCommentsForLLM(comments),
              null,
              request.model,
              token,
            );
            await ws.update('jira.session.commentList', buildCommentListSession(ticketKey!, comments));
            stream.markdown(base + '\n\n**Comments (summarized):**\n\n' + synthesis);
            if (total > MAX_SHOW) {
              const moreSession: MoreCommentsSession = { ticketKey: ticketKey!, commentQuery: null };
              await ws.update('jira.session.moreComments', moreSession);
              stream.markdown(olderCommentsNotShownLink(total - MAX_SHOW));
              // R13: carry the ticket key on metadata instead of a visible marker.
              return withLastTicket(ticketKey!, ['more-comments', 'comment-list']);
            } else {
              return withLastTicket(ticketKey!, ['comment-list']);
            }
          }
          result = base;
          break;
        }
        case 'summarizeTicket': {
          const summaryFieldMeta = await ticketService.getFieldMeta();
          const summaryAlwaysShow = new Set<string>(config.additionalDisplayFields);
          const summaryHidden = new Set<string>(config.hiddenDisplayFields);
          const fullTicket = await ticketService.getTicket(ticketKey!, summaryFieldMeta, summaryAlwaysShow, summaryHidden, config.baseUrl);
          // Title + table before the first ## section heading
          const sectionStart = fullTicket.indexOf('\n\n## ');
          const fieldsHeader = sectionStart >= 0 ? fullTicket.slice(0, sectionStart) : fullTicket;
          const descriptionText = sectionStart >= 0 ? fullTicket.slice(sectionStart + 2) : '';
          const { comments: summaryComments } = await ticketService.getIssueComments(ticketKey!, 20);
          const commentBlocks = summaryComments.length > 0 ? serializeCommentsForLLM(summaryComments) : null;
          const synthesis = await generateDescriptionAndCommentsSummary(descriptionText, commentBlocks, request.model, token);
          stream.markdown(fieldsHeader + '\n\n**Overview (summarized):**\n\n' + synthesis);
          // R13: carry the ticket key on metadata instead of a visible marker.
          return withLastTicket(ticketKey!);
        }
        case 'showComments': {
          const MAX_SHOW_FULL = 20;
          const { comments: fullComments, total: fullTotal } = await ticketService.getIssueComments(ticketKey!, MAX_SHOW_FULL);
          if (fullComments.length === 0) {
            result = `No comments on ${ticketKey}.`;
            break;
          }
          await ws.update('jira.session.commentList', buildCommentListSession(ticketKey!, fullComments));
          const showTicketRef = formatKeyLink(ticketKey!, config.baseUrl);
          stream.markdown(`## ${showTicketRef} — Comments (${fullTotal})\n\n` + formatCommentsInFull(fullComments));
          if (fullTotal > MAX_SHOW_FULL) {
            const moreSession: MoreCommentsSession = { ticketKey: ticketKey!, commentQuery: null, displayMode: 'full' };
            await ws.update('jira.session.moreComments', moreSession);
            stream.markdown(olderCommentsNotShownLink(fullTotal - MAX_SHOW_FULL));
            // R13: carry the ticket key on metadata instead of a visible marker.
            return withLastTicket(ticketKey!, ['more-comments', 'comment-list']);
          } else {
            return withLastTicket(ticketKey!, ['comment-list']);
          }
        }
        case 'getComments': {
          const MAX_INITIAL = 20;
          const { comments, total } = await ticketService.getIssueComments(ticketKey!, MAX_INITIAL);
          if (comments.length === 0) {
            result = `No comments on ${ticketKey}.`;
            break;
          }
          const synthesis = await synthesizeComments(
            serializeCommentsForLLM(comments),
            intent.commentQuery,
            request.model,
            token,
          );
          const hasQuery = Boolean(intent.commentQuery);
          if (!hasQuery) {
            await ws.update('jira.session.commentList', buildCommentListSession(ticketKey!, comments));
          }
          const getCommentsRef = formatKeyLink(ticketKey!, config.baseUrl);
          stream.markdown(`**${getCommentsRef} — Comments**\n\n` + synthesis);
          const listKinds: JiraSessionKind[] = hasQuery ? [] : ['comment-list'];
          if (total > MAX_INITIAL) {
            const moreSession: MoreCommentsSession = { ticketKey: ticketKey!, commentQuery: intent.commentQuery };
            await ws.update('jira.session.moreComments', moreSession);
            stream.markdown(olderCommentsNotShownLink(total - MAX_INITIAL));
            // R13: carry the ticket key on metadata instead of a visible marker.
            return withLastTicket(ticketKey!, ['more-comments', ...listKinds]);
          } else {
            // R13: always carry the ticket key now (even when no comment-list session started),
            // so a bare "show comments" reply still resolves as the last-referenced ticket.
            return withLastTicket(ticketKey!, listKinds);
          }
        }
        case 'addComment': {
          const isLiteral = intent.contentSource === 'literal' || intent.contentSource === undefined;
          if (!intent.comment && isLiteral) {
            stream.markdown('What comment would you like to add?');
            return;
          }
          if (isLiteral) {
            result = await ticketService.addComment(ticketKey!, intent.comment!, config.baseUrl);
          } else {
            const ticketText = await ticketService.getTicket(ticketKey!);
            const { comments } = await ticketService.getIssueComments(ticketKey!, 50);
            const commentBlocks = comments.length > 0 ? serializeCommentsForLLM(comments) : '';

            // Verbatim shortcut: when the user points at the previous response ("post it",
            // "use that"), copy the last assistant turn directly instead of re-generating.
            if (intent.contentSource === 'history-recent' && isPointerPrompt(request.prompt)) {
              const lastText = extractLastAssistantText(chatContext);
              if (lastText.length > 200) {
                return await streamContentPreview(
                  { ticketKey: ticketKey!, operation: 'addComment', currentContent: lastText, historyContext: undefined, contentSource: 'history-recent' },
                  stream, ws,
                );
              }
            }

            const nonLiteralSource = intent.contentSource as 'generate' | 'history-recent' | 'history-full';
            const context = await buildContentContext(request, chatContext, ticketText, commentBlocks, nonLiteralSource);
            const content = await generateContent(request.prompt, request.model, token, context, nonLiteralSource);
            if (isLmRefusal(content)) {
              stream.markdown(`_Could not generate comment content — the AI model declined the request. Try rephrasing your instruction or use \`@jira add comment to ${ticketKey}\` with explicit text._`);
              return;
            }
            return await streamContentPreview(
              { ticketKey: ticketKey!, operation: 'addComment', currentContent: content, historyContext: context, contentSource: nonLiteralSource },
              stream, ws,
            );
          }
          break;
        }
        case 'updateField': {
          const fieldNameRaw = intent.fieldName ?? intent.fieldUpdates?.[0]?.fieldName;
          const fieldValueRaw = intent.fieldValue ?? intent.fieldUpdates?.[0]?.fieldValue ?? '';
          if (!fieldNameRaw) {
            stream.markdown('Please specify a field name and value to update.');
            return;
          }
          // Description with non-literal content → ContentSession
          const isNonLiteral = intent.contentSource !== 'literal' && intent.contentSource !== undefined;
          if (fieldNameRaw.toLowerCase() === 'description' && isNonLiteral) {
            const descFieldMeta = await ticketService.getFieldMeta();
            const descAlwaysShow = new Set<string>(config.additionalDisplayFields);
            const descHidden = new Set<string>(config.hiddenDisplayFields);
            const ticketText = await ticketService.getTicket(ticketKey!, descFieldMeta, descAlwaysShow, descHidden);
            const { comments } = await ticketService.getIssueComments(ticketKey!, 20);
            const commentBlocks = comments.length > 0 ? serializeCommentsForLLM(comments) : '';
            const nonLiteralSource = intent.contentSource as 'generate' | 'history-recent' | 'history-full';
            const contentCtx = await buildContentContext(request, chatContext, ticketText, commentBlocks, nonLiteralSource);
            const content = await generateContent(fieldValueRaw, request.model, token, contentCtx, nonLiteralSource);
            if (isLmRefusal(content)) {
              stream.markdown(`_Could not generate description content — the AI model declined the request. Try rephrasing your instruction._`);
              return;
            }
            return await streamContentPreview(
              { ticketKey: ticketKey!, operation: 'updateDescription', currentContent: content, historyContext: contentCtx, contentSource: nonLiteralSource },
              stream, ws,
            );
          }
          // All other fields → fuzzy match + preview flow
          const setFieldMeta = await ticketService.getFieldMeta();
          const setTicketKeys = intent.scope === 'bulk'
            ? (ws.get<SearchResultSession>('jira.session.searchResult')?.ticketKeys ?? [ticketKey!])
            : [ticketKey!];
          return await handleSetField(
            setTicketKeys, fieldNameRaw, fieldValueRaw, intent.arrayOp ?? 'set',
            setFieldMeta, ticketService, stream, ws, request.model, token,
          );
        }
        case 'showFields': {
          const showFieldMeta = await ticketService.getFieldMeta();
          result = await ticketService.showFields(ticketKey!, showFieldMeta);
          break;
        }
        case 'searchJql': {
          let resolvedJql: string;
          let jqlLabel = '';
          if (intent.filterId) {
            const filter = await ticketService.getFilterById(intent.filterId);
            resolvedJql = filter.jql;
            jqlLabel = `_Using filter: **${filter.name}**_\n\n`;
          } else if (intent.filterName) {
            const filters = await ticketService.searchFiltersByName(intent.filterName);
            if (filters.length === 0) {
              result = `No saved filters found matching "${intent.filterName}".`;
              break;
            } else if (filters.length === 1) {
              resolvedJql = filters[0].jql;
              jqlLabel = `_Using filter: **${filters[0].name}**_\n\n`;
            } else {
              const session: FilterSelectionSession = { filters, originalPrompt: request.prompt };
              await ws.update('jira.session.filterSelection', session);
              const list = filters.map((f, i) => `${i + 1}. ${buildChatCommandLink(f.name, '@jira', String(i + 1))}`).join('\n');
              stream.markdown(trustedChatMarkdown(
                `Multiple filters match "${intent.filterName}":\n\n${list}\n\nWhich one? Reply with the number or name, or ${buildChatCommandLink('Cancel', '@jira', 'cancel')}.`,
              ));
              return { metadata: { jiraSession: { kinds: ['selecting-filter'] } } };
            }
          } else if (intent.useMyTeamJql) {
            const teamJql = config.myTeamJql;
            if (!teamJql) {
              result =
                'No team JQL configured. Set `ticketSidekick.jira.myTeamJql` in your VS Code settings (e.g. `project = BACKEND AND assignee in membersOf("backend-team")`).';
              break;
            }
            resolvedJql = buildTeamJql(teamJql, intent.jql);
            jqlLabel = `_Using team JQL_\n\n`;
          } else {
            resolvedJql = intent.jql ?? request.prompt;
          }
          const raw = await ticketService.searchTicketsRaw(resolvedJql);
          if (raw.issues.length > 0) {
            const searchSession: SearchResultSession = { ticketKeys: raw.issues.map(i => i.key), jql: resolvedJql };
            await ws.update('jira.session.searchResult', searchSession);
          }
          const searchFieldMeta = config.searchFields.length > 0 ? await ticketService.getFieldMeta() : [];
          const searchResult = jqlLabel + await ticketService.searchTickets(resolvedJql, config.baseUrl, config.searchFields, searchFieldMeta);
          // U5/R9: the search-results table's Actions column can contain real command links
          // (view/load), so this response needs the trusted-markdown gate the shared tail below
          // doesn't apply. searchJql doesn't set `ticketKey`, so that shared tail wouldn't do
          // anything for this case anyway (no follow-up-chip metadata) — return directly instead
          // of widening the shared `result: string` variable's type for every other case.
          stream.markdown(trustedChatMarkdown(searchResult));
          return;
        }
        case 'transition': {
          if (!intent.targetStatus) {
            // R2/F1: the "Transition it" chip (and any other "transition {key}" prompt that
            // names no status) now opens the guided flow instead of this dead-end message — the
            // old static text is gone, not left dead alongside it (Definition of Done). A target
            // status typed directly (e.g. "@jira move PROJ-123 to Done") never enters this branch
            // at all, since `intent.targetStatus` is already set — it goes straight into the
            // resolveAndApplyTransition call below, unchanged.
            const guidedWorkspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
            return await startGuidedTransition(ticketKey!, jiraClient, stream, ws, guidedWorkspaceRoot);
          }
          const targetStatus = intent.targetStatus;
          const transWorkspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
          // Same resolution algorithm `jira_transitionTicket` uses (src/services/WorkflowService.ts) —
          // R3: one implementation, reused by both the chat flow and the Language Model tool.
          const transResult = await resolveAndApplyTransition(
            jiraClient, ticketService, transWorkspaceRoot, ticketKey!, targetStatus, intent.resolution ?? undefined,
          );
          switch (transResult.kind) {
            case 'alreadyThere':
              result = `**${ticketKey}** is already in **${transResult.currentStatus}**.`;
              break;
            case 'direct':
              result = `**${ticketKey}** moved to **${transResult.toStatus}**.`;
              break;
            case 'multiHop':
              result = `**${ticketKey}** moved to **${transResult.toStatus}** (${transResult.hops} hop${transResult.hops > 1 ? 's' : ''}).`;
              break;
            case 'partialFailure':
              result = formatPartialTransitionFailure(
                ticketKey!, transResult.landedStatus, transResult.completedHops, transResult.totalHops,
                transResult.targetStatus, transResult.error,
              );
              break;
            case 'unavailable': {
              const available = transResult.available.map(name => `**${name}**`).join(', ');
              const cacheHint = transResult.hasCache
                ? ''
                : ` Run \`@jira discover workflow ${transResult.projectKey} ${transResult.issueType || '<issuetype>'}\` to enable multi-hop transitions.`;
              result = `No transition to **${targetStatus}** available from **${transResult.currentStatus}**.${available ? ` Available: ${available}.` : ''}${cacheHint}`;
              break;
            }
          }
          break;
        }
        case 'bulkTransition': {
          const searchSession = ws.get<SearchResultSession>('jira.session.searchResult');
          if (!searchSession || searchSession.ticketKeys.length === 0) {
            result = 'No previous search results to act on. Run a search first.';
            break;
          }
          if (!intent.targetStatus) {
            result = 'Please specify a target status (e.g. "transition them to Done").';
            break;
          }
          const targetStatus = intent.targetStatus;
          stream.markdown(`_Building transition paths…_\n\n`);
          const cleanupFieldMeta = config.cleanupFields.length > 0 ? await ticketService.getFieldMeta() : [];
          const tickets: TransitionBatchTicket[] = [];
          for (const key of searchSession.ticketKeys) {
            const issue = await jiraClient.getIssue(key);
            const transitions = await jiraClient.getTransitions(key);
            // Build a single-level graph from the ticket's current available transitions
            const graph: WorkflowGraph = {
              [issue.fields.status.name]: transitions.map(t => ({ id: t.id, name: t.name, to: t.to.name })),
            };
            const currentStatus = issue.fields.status.name;
            const path = findPath(graph, currentStatus, targetStatus);
            if (path === null) {
              stream.markdown(`_Warning: no direct transition from **${currentStatus}** to **${targetStatus}** for ${key} — skipping. Use a workflow cache for multi-hop paths._\n\n`);
              continue;
            }
            const subtasks: TransitionSubtask[] = [];
            for (const s of (issue.fields.subtasks ?? [])) {
              const subTransitions = await jiraClient.getTransitions(s.key);
              const subGraph: WorkflowGraph = {
                [s.fields.status.name]: subTransitions.map(t => ({ id: t.id, name: t.name, to: t.to.name })),
              };
              const subPath = findPath(subGraph, s.fields.status.name, targetStatus);
              if (subPath) subtasks.push({ key: s.key, summary: s.fields.summary, currentStatus: s.fields.status.name, transitionPath: subPath, included: true });
            }
            tickets.push({
              key, summary: issue.fields.summary, currentStatus, transitionPath: path, subtasks,
              extra: extractExtraFields(issue.fields, config.cleanupFields),
              included: true,
            });
          }
          if (tickets.length === 0) {
            result = `No tickets could be transitioned to **${targetStatus}** — all were either already there or have no direct path.`;
            break;
          }
          // Subtasks come from the parent's embedded `fields.subtasks`, which only carries
          // key/summary/status regardless of what fields the parent was fetched with (KTD3) — a
          // batched `parent in (...)` search gets their real cleanupFields values in one call.
          if (config.cleanupFields.length > 0) {
            const parentKeys = tickets.filter((t) => t.subtasks.length > 0).map((t) => t.key);
            if (parentKeys.length > 0) {
              const subJql = `parent in (${parentKeys.map((k) => `"${k}"`).join(', ')})`;
              const subResult = await ticketService.searchTicketsRaw(subJql, 250, config.cleanupFields);
              const extraByKey = new Map(subResult.issues.map((s) => [s.key, extractExtraFields(s.fields, config.cleanupFields)]));
              for (const t of tickets) {
                for (const s of t.subtasks) s.extra = extraByKey.get(s.key);
              }
            }
          }
          const CLOSED_STATES = new Set(['done', 'closed', 'resolved', 'cancelled', 'canceled']);
          if (CLOSED_STATES.has(targetStatus.toLowerCase())) {
            const resolutions = await jiraClient.getResolutions();
            if (resolutions.length > 0) {
              const resSession: ResolutionSelectionSession = {
                resolutionOptions: resolutions.map(r => r.name),
                tickets,
                ruleName: undefined,
                issueType: intent.issueType ?? '',
                targetState: targetStatus,
                fieldIds: config.cleanupFields,
                fieldMeta: cleanupFieldMeta,
              };
              await ws.update('jira.session.resolutionSelection', resSession);
              // Code-review fix: mirror the retry branch above (line ~195) and cleanupHandler.ts's
              // equivalent — this initial prompt had drifted to plain, non-clickable text.
              const list = resolutions.map((r, i) => `${i + 1}. ${buildChatCommandLink(r.name, '@jira', String(i + 1))}`).join('\n');
              stream.markdown(trustedChatMarkdown(
                `Which resolution should be set when transitioning to **${targetStatus}**?\n\n${list}\n\nReply with the name or number, or ${buildChatCommandLink('none', '@jira', 'none')} to skip setting a resolution.`,
              ));
              return { metadata: { jiraSession: { kinds: ['resolution-selection'] } } };
            }
          }
          const batchSession: TransitionBatchSession = {
            tickets, resolution: undefined, ruleName: undefined, issueType: intent.issueType ?? '',
            fieldIds: config.cleanupFields, fieldMeta: cleanupFieldMeta,
          };
          return await streamReviewScreen(batchSession, stream, ws, `**Bulk transition → ${targetStatus}**`, config.baseUrl);
        }
        case 'bulkUpdateField': {
          const searchSession = ws.get<SearchResultSession>('jira.session.searchResult');
          if (!searchSession || searchSession.ticketKeys.length === 0) {
            result = 'No previous search results to act on. Run a search first.';
            break;
          }
          if (!intent.bulkFieldName || intent.bulkFieldValue === null) {
            result = 'Please specify both a field name and a value (e.g. "set Team Names to ASL Cary").';
            break;
          }
          const fieldId = await ticketService.resolveFieldId(intent.bulkFieldName);
          const allFieldMeta = await ticketService.getFieldMeta();
          const targetFieldMeta = allFieldMeta.find(f => f.id === fieldId);
          const isSprintField = Boolean(targetFieldMeta?.schema.custom?.includes('gh-sprint'));

          let fieldValue: unknown;
          if (isSprintField) {
            const projectKey = searchSession.ticketKeys[0].split('-')[0];
            let candidates;
            try {
              candidates = await ticketService.findSprints(projectKey, intent.bulkFieldValue!);
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              logDiag('jira.participant', 'error', message, {});
              result = `Could not search sprints: ${message}`;
              break;
            }
            if (candidates.length === 0) {
              result = `No active or future sprint matching "${intent.bulkFieldValue}" in project ${projectKey}.`;
              break;
            }
            const chosen = candidates.find(s => s.state === 'active') ?? candidates[0];
            fieldValue = chosen.id;
          } else {
            fieldValue = await ticketService.buildFieldValue(fieldId, searchSession.ticketKeys[0], intent.bulkFieldValue!);
          }

          const issues = await Promise.all(searchSession.ticketKeys.map(k => jiraClient.getIssue(k)));
          const reviewRows: BulkUpdateReviewRow[] = issues.map(issue => {
            const current = issue.fields[fieldId];
            const display = current !== null && current !== undefined && targetFieldMeta
              ? renderFieldValue(current, targetFieldMeta)
              : current !== null && current !== undefined
                ? String(current)
                : '—';
            return { key: issue.key, summary: issue.fields.summary, currentValueDisplay: display, included: true };
          });
          const headerLine =
            `**Bulk update: ${intent.bulkFieldName} → ${intent.bulkFieldValue}**\n` +
            `(${searchSession.ticketKeys.length} tickets)\n\n` +
            (config.baseUrl ? `[View in Jira](${config.baseUrl}/issues/?jql=${encodeURIComponent(searchSession.jql)})` : '');
          const bulkSession: BulkUpdateReviewSession = {
            rows: reviewRows,
            fieldId,
            fieldName: intent.bulkFieldName,
            fieldValue,
            arrayOp: 'set',
            headerLine,
          };
          await ws.update('jira.session.bulkUpdateReview', bulkSession);
          stream.markdown(trustedChatMarkdown(buildBulkUpdateReviewMessage(headerLine, reviewRows)));
          return { metadata: { jiraSession: { kinds: ['bulk-update-review'] } } };
        }
        case 'loadTicket': {
          const loadFieldMeta = await ticketService.getFieldMeta();
          const loadAlwaysShow = new Set<string>(config.additionalDisplayFields);
          const loadHidden = new Set<string>(config.hiddenDisplayFields);
          const { hasSkippedAttachments, projectKey: loadedProjectKey, issueType: loadedIssueType } =
            await handleLoadTicket(ticketKey!, ticketService, stream, ws, loadFieldMeta, loadAlwaysShow, loadHidden);
          // R6/R7: "transition it, create a template from it, discover its workflow" — the
          // flagship examples the plan names for follow-up chips, built from the ticket
          // handleLoadTicket already fetched (KTD4 — no second getIssue call for the chips).
          const loadedState: JiraFollowupState = {
            kind: 'loadedTicket',
            ticketKey: ticketKey!,
            projectKey: loadedProjectKey,
            issueType: loadedIssueType,
          };
          // R13: carry the loaded ticket key on metadata instead of a visible marker. Empty
          // kinds when no load-skipped session started — keeps every detection check false.
          return {
            metadata: {
              jiraFollowup: loadedState,
              ...withLastTicket(ticketKey!, hasSkippedAttachments ? ['load-skipped'] : []).metadata,
            },
          };
        }
        case 'validateFields':
          result = await ticketService.validateRequiredFields(ticketKey!, config.requiredFields);
          break;
        case 'spellCheck': {
          if (!ticketKey) {
            stream.markdown('No ticket key found. Please specify a ticket, e.g. `@jira spell check PROJ-123`.');
            return;
          }
          return await handleSpellCheck(ticketKey, ticketService, request.model, stream, token, ws);
        }
        default: {
          // R8: replaces the bare "Unrecognised operation." message — an example-driven
          // response mirroring @bitbucket's existing no-PR-URL guidance, with the examples
          // delivered as follow-up chips (KTD14) rather than repeated as inline prose.
          stream.markdown(
            "I couldn't tell what you'd like to do. Try being more specific — name a ticket " +
            'and an action — or try one of the suggestions below.\n\n' + SAVED_FILTER_TIP,
          );
          // R4/AE3: same branch-resolution rule as greeting — never a fabricated ticket key.
          const fallbackState: JiraFollowupState = { kind: 'fallback', branchKey: resolveTicketFromBranch() ?? undefined };
          return { metadata: { jiraFollowup: fallbackState } };
        }
      }
      stream.markdown(result);
      if (ticketKey) {
        // `justDid` lets computeJiraFollowups leave out a chip that would just repeat the
        // action this operation itself performed (e.g. no "transition it" chip right after
        // `transition` succeeded). R13: carry the ticket key on metadata instead of a visible
        // marker. R6/R7: the "Create a template" chip only needs the ticket key (free). The
        // "Discover workflow" chip additionally needs the issue type — KTD4 deliberately reads
        // that from data already in hand rather than an extra fetch, and none of the operations
        // landing in this shared tail (addComment, updateField, transition, …) already have the
        // raw issue in scope, so this site leaves issueType empty and computeJiraFollowups omits
        // that one chip here rather than paying for a fresh `getIssue` call on every response.
        // `loadTicket`'s own case above populates issueType properly, since it already fetched
        // the issue for the ticket view itself.
        const tailProjectKey = extractProjectKeyFromTicketKey(ticketKey) ?? ticketKey.split('-')[0];
        const viewedState: JiraFollowupState = {
          kind: 'loadedTicket',
          ticketKey,
          projectKey: tailProjectKey,
          issueType: '',
          justDid: intent.operation,
        };
        return { metadata: { jiraFollowup: viewedState, ...withLastTicket(ticketKey).metadata } };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logDiag('jira.participant', 'error', message, { operation: intent.operation });
      stream.markdown(message);
    }
  };

  const participant = vscode.chat.createChatParticipant('ticket-sidekick.jira', handler);
  // U5/R6: follow-up suggestion chips for the response `result` was just returned from —
  // `result.metadata.jiraFollowup` is set above wherever the handler has chip-worthy state;
  // no metadata (a bare `return;`) means no chips, e.g. a multi-turn session reply whose own
  // response already carries the next-step guidance.
  participant.followupProvider = {
    provideFollowups(result: vscode.ChatResult): vscode.ChatFollowup[] {
      const state = (result.metadata as { jiraFollowup?: JiraFollowupState } | undefined)?.jiraFollowup;
      if (!state) return [];
      return computeJiraFollowups(state).map((s) => ({ prompt: s.prompt, label: s.label }));
    },
  };
  context.subscriptions.push(participant);
  return participant;
}
