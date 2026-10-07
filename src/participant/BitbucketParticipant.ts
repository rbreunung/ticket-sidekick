import * as vscode from 'vscode';
import { minimatch } from 'minimatch';
import { BitbucketApiClient } from '../bitbucket/BitbucketApiClient';
import type { BitbucketConfig, BitbucketPR } from '../bitbucket/IBitbucketClient';
import type { ConfigService } from '../services/ConfigService';
import { PrReviewService, PERSONAS, type Persona, type PersonaId } from '../services/PrReviewService';
import {
  parsePrUrl,
  parseDiff,
  parseFollowUpIntent,
  formatReviewForSharing,
  extractPromptDirectives,
  buildPrContextPrompt,
  buildDiffAwarePrompt,
  buildFindingFollowUpPrompt,
  parseFindingMatchReply,
  buildStoredReviewDiff,
  parseReviewReply,
  buildAdaptiveChunks,
  resolveFindingAnchors,
  estimateChunkTokens,
  selectFilesWithinBudget,
  MAX_CONTEXT_FILES_PER_BATCH,
  parseCriticKeep,
  parseCriticAdditionalFiles,
  dedupeFindings,
  buildRunTag,
  formatCallLine,
  buildTruncationEvent,
  formatRecoveryDecision,
  formatFindingsFunnel,
  formatStructuredRunRecord,
  formatContinuationMessage,
  formatDroppedFindingsNotice,
  mergePass2Findings,
  RAW_PREVIEW_CHARS,
  createAttemptTracker,
  computeBitbucketFollowups,
  resolveReviewMode,
  deriveCriticEnabled,
  parseSmartFallbackReply,
  aggregateRecommendedPersonas,
  buildChatCommandLink,
  composeReviewOutput,
  hasPrUrl,
  isUsageRequest,
  isEndSessionRequest,
  isReviewStartWithoutUrl,
  endBitbucketSessions,
  hasStoredBitbucketSession,
  type ReviewFinding,
  type ReviewSession,
  type BitbucketCommentPreviewSession,
  type BitbucketFollowupState,
  type BitbucketSessionContinuity,
  type FileDiff,
  type SmartFallbackSession,
  type ParsedReviewReply,
  type ReviewPass,
  type ReviewTally,
} from './reviewSessionState';
import { isConfirmation, isGreetingOrEmpty } from './sessionState';
import { generateContent } from './jira/llmHelpers';
import { createTokenMeter } from './bitbucket/tokenMeter';
import { JiraApiClient } from '../jira/JiraApiClient';
import { TicketService } from '../services/TicketService';
import { extractTicketId } from '../utils/branchParser';
import { formatRequirementsSourceText, type RequirementsSource } from '../utils/requirementsSource';
import {
  parseRequirementsReply, buildCoverage, renderCoverageMarkdown, renderCoverageText, packDiffFiles,
  type RequirementsCoverage,
} from './bitbucket/requirementsCoverage';
import {
  decideTicketStep, buildTicketPause, buildTicketHintLine, buildIgnoredTicketLine,
  buildNotConfiguredLine, buildNoKeyLine, buildTicketFailureLine,
} from './bitbucket/requirementsFlow';
import { TokenUsageService, formatTokenFooter, formatUsageTable } from '../utils/tokenUsage';
import { trustedChatMarkdown } from '../utils/chatMarkdown';
import { tokenStatus } from '../utils/diagUtils';
import { validateBaseUrl } from '../services/configValidation';
import { withLmRetry, withEasierRetry, isTransientLmError, PartialLmResponseError, UnparseableReplyError } from '../utils/lmRetry';
import { logDiag } from '../utils/diagLog';
import { sanitizeDetails } from '../utils/logRedaction';
import {
  errorCodeOf, handleAttemptFailure, describeErrorForLog,
  formatBatchFailureNotice, formatReviewFailedMessage, PARTIAL_REVIEW_WARNING,
  type CallAttemptOut, type CallDiagHooks,
} from './bitbucket/reviewDiagnostics';

// R1/R3/U4: replaces the former `getLastAssistantText(...).includes('<!-- bitbucket:TAG -->')` — reads the
// metadata a session-producing response returned via `{ metadata: { bitbucketSession } }` off the
// last turn in `chatContext.history` instead of scanning rendered text, so no visible artifact of
// session-tracking remains in the transcript. Mirrors `getActiveJiraSession` in
// `jira/ticketContext.ts`. Returns undefined when the last turn isn't a `ChatResponseTurn`, carries
// no result metadata, or the user has moved on since — matching today's "tag absent" behavior.
function getActiveBitbucketSession(chatContext: vscode.ChatContext): BitbucketSessionContinuity | undefined {
  const last = chatContext.history[chatContext.history.length - 1];
  if (!(last instanceof vscode.ChatResponseTurn)) return undefined;
  const metadata = last.result.metadata as { bitbucketSession?: BitbucketSessionContinuity } | undefined;
  return metadata?.bitbucketSession;
}


function logLmFailure(
  contextLabel: string,
  attempt: number,
  err: unknown,
  extra?: Record<string, unknown>,
): void {
  const cause = (err as { cause?: unknown })?.cause;
  const partialText = err instanceof PartialLmResponseError ? err.partialText : undefined;
  logDiag('bitbucket.review', 'error', `LLM call failed — ${contextLabel} (attempt ${attempt})`, {
    ...extra,
    error: err instanceof Error ? err.message : String(err),
    ...describeErrorForLog(err),
    cause: cause instanceof Error ? cause.message : cause !== undefined ? String(cause) : undefined,
    partialTextChars: partialText?.length,
    partialTextPreview: partialText?.slice(0, RAW_PREVIEW_CHARS),
  });
}

function describeFailure(err: unknown): string {
  const partial = err instanceof PartialLmResponseError ? err.partialText : undefined;
  const base = err instanceof Error ? err.message : String(err);
  return partial
    ? `${base} — model's partial reply: "${partial.slice(0, RAW_PREVIEW_CHARS)}${partial.length > RAW_PREVIEW_CHARS ? '…' : ''}"`
    : base;
}

function friendlyLmFailureMessage(prefix: string, err: unknown): string {
  if (isTransientLmError(err) && !(err instanceof PartialLmResponseError)) {
    return `${prefix} the model returned an empty response after retrying — this is usually a transient provider hiccup, more likely in \`deep\` mode since it makes more model calls per review. Try again, or drop \`deep\` for a lighter run. _(see the "Ticket Sidekick" output channel for details)_`;
  }
  return `${prefix} ${describeFailure(err)}`;
}

/** Single attempt, no retry — the primitive every retry wrapper builds on. */
async function callLLMOnce(
  prompt: string,
  model: vscode.LanguageModelChat,
  token: vscode.CancellationToken,
  onChunk?: (totalChars: number) => void,
): Promise<string> {
  const response = await model.sendRequest(
    [vscode.LanguageModelChatMessage.User(prompt)],
    {},
    token,
  );
  let text = '';
  try {
    for await (const chunk of response.text) {
      text += chunk;
      onChunk?.(text.length);
    }
  } catch (err) {
    // The stream broke mid-reply. If it had already sent something —
    // possibly a clarifying question, or a partial explanation — keep it
    // instead of throwing the raw stream error and losing it.
    if (text.trim()) throw new PartialLmResponseError(text.trim(), err);
    throw err;
  }
  return text.trim();
}

async function callLLMOnceWithProgress(
  prompt: string,
  model: vscode.LanguageModelChat,
  token: vscode.CancellationToken,
  statusMessage: string,
): Promise<string> {
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: 'Ticket Sidekick' },
    (progress) => callLLMOnce(prompt, model, token, (chars) => {
      progress.report({ message: `${statusMessage} · ${chars.toLocaleString()} chars…` });
    }),
  );
}

/** 3 identical tries (see lmRetry.ts) — for a single, non-splittable prompt. */
async function callLLM(
  prompt: string,
  model: vscode.LanguageModelChat,
  token: vscode.CancellationToken,
  contextLabel: string,
  onChunk?: (totalChars: number) => void,
  diag?: CallDiagHooks,
  validateReply?: (raw: string) => void,
): Promise<string> {
  let attempt = 0;
  let attemptStart = 0;
  const raw = await withLmRetry(
    async () => {
      attempt++;
      attemptStart = Date.now();
      const reply = await callLLMOnce(prompt, model, token, onChunk);
      validateReply?.(reply);
      return reply;
    },
    {
      onAttemptFailed: (a, err) => {
        logLmFailure(contextLabel, a, err, {
          promptChars: prompt.length,
          estimatedTokens: Math.ceil(prompt.length / 4),
        });
        diag?.onAttemptError?.(a, Date.now() - attemptStart, errorCodeOf(err));
      },
    },
  );
  if (diag?.attemptOut) {
    diag.attemptOut.attempt = attempt;
    diag.attemptOut.durationMs = Date.now() - attemptStart;
  }
  return raw;
}

async function callLLMWithProgress(
  prompt: string,
  model: vscode.LanguageModelChat,
  token: vscode.CancellationToken,
  statusMessage: string,
  contextLabel: string,
  diag?: CallDiagHooks,
  validateReply?: (raw: string) => void,
): Promise<string> {
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: 'Ticket Sidekick' },
    (progress) => callLLM(prompt, model, token, contextLabel, (chars) => {
      progress.report({ message: `${statusMessage} · ${chars.toLocaleString()} chars…` });
    }, diag, validateReply),
  );
}

/**
 * KTD3: runs inside every retried review call, so a reply with nothing review-shaped (empty, or
 * prose with no usable JSON) is retried and split like a provider error instead of aborting the
 * whole review. A cut-off reply is not unreadable — the continuation pass recovers it.
 */
function assertReadableReply(raw: string): void {
  const reply = parseReviewReply(raw);
  if (!reply.hasJson && !reply.truncated) throw new UnparseableReplyError(raw);
}

async function parseReviewResponse(raw: string): Promise<{
  findings: Array<Omit<ReviewFinding, 'id'>>;
  additionalFilesNeeded: string[];
  truncated?: true;
  /** The shape U4's truncation event needs, carried through so a truncation branch doesn't
   * have to re-parse `raw` a second time. */
  hasMetaLine?: boolean;
  danglingTail?: string;
  /** U7/KTD2: persona ids the standard pass recommended for this chunk — only meaningful
   * (and only ever requested) for smart mode's phase-1 call. */
  recommendedPersonas?: string[];
}> {
  const reply = parseReviewReply(raw);
  if (!reply.hasJson && !reply.truncated) {
    throw new Error(`LLM returned no JSON for review.\n\nRaw (first 600):\n${raw.slice(0, 600) || '(empty)'}`);
  }
  return {
    findings: reply.findings as Array<Omit<ReviewFinding, 'id'>>,
    additionalFilesNeeded: reply.additionalFilesNeeded,
    hasMetaLine: reply.hasMetaLine,
    recommendedPersonas: reply.recommendedPersonas,
    ...(reply.danglingTail !== undefined ? { danglingTail: reply.danglingTail } : {}),
    ...(reply.truncated ? { truncated: true as const } : {}),
  };
}

function splitFilesInHalf(items: FileDiff[]): [FileDiff[], FileDiff[]] {
  const mid = Math.ceil(items.length / 2);
  return [items.slice(0, mid), items.slice(mid)];
}

/**
 * Shared by pass1→pass2's additionalFilesNeeded fetch and the critic's file-pulling
 * round (R9/KTD4): fetch any requested files not already in the cross-batch
 * `fetchedFileCache`, then select as many as fit the remaining token budget. Callers
 * differ only in which files they're requesting and budgeting against, and in the
 * stream/log message text — everything else (cache-check, cap, fetch, select) is
 * identical between the two call sites.
 */
async function fetchAndBudgetContextFiles(params: {
  requestedFiles: string[];
  fetchedFileCache: Map<string, string>;
  service: PrReviewService;
  project: string;
  repo: string;
  commitHash: string;
  tokenBudget: number;
  /** The diff items to subtract from `tokenBudget` via `estimateChunkTokens` before selecting. */
  budgetAgainst: FileDiff[];
  fetchMessage: (count: number) => string;
  logLabel: string;
  batchNum: number;
  logReview: (level: 'info' | 'warn' | 'error', message: string, details?: Record<string, unknown>) => void;
  stream: vscode.ChatResponseStream;
}): Promise<Map<string, string>> {
  const { requestedFiles, fetchedFileCache, service, project, repo, commitHash, tokenBudget, budgetAgainst, fetchMessage, logLabel, batchNum, logReview, stream } = params;
  const toFetch = requestedFiles.filter((p) => !fetchedFileCache.has(p)).slice(0, MAX_CONTEXT_FILES_PER_BATCH);
  if (toFetch.length > 0) {
    stream.markdown(fetchMessage(toFetch.length));
    const fetched = await service.gatherFileContents(project, repo, commitHash, toFetch);
    for (const [p, c] of fetched) fetchedFileCache.set(p, c);
    logReview('info', `${logLabel} — batch ${batchNum}`, {
      batch: batchNum, requestedCount: toFetch.length, fetchedCount: fetched.size,
    });
  }
  const requestedEntries = requestedFiles
    .filter((p) => fetchedFileCache.has(p))
    .map((p) => ({ path: p, content: fetchedFileCache.get(p)! }));
  const contentBudget = Math.max(0, tokenBudget - estimateChunkTokens(budgetAgainst));
  const { selected, skipped } = selectFilesWithinBudget(requestedEntries, contentBudget);
  if (skipped.length > 0) {
    logReview('info', `${logLabel} — ${skipped.length} file(s) skipped, over the context budget — batch ${batchNum}`, {
      batch: batchNum, skipped, contentBudgetTokens: contentBudget,
    });
  }
  return selected;
}

/** Tokens reserved for the instructions, PR text and reply when packing diff files into the requirements prompt. */
const REQUIREMENTS_PROMPT_OVERHEAD_TOKENS = 800;

/**
 * The requirements pass: one call over the whole PR (not per chunk) comparing the diff with the
 * ticket, plus at most one round of extra files the model asks for. Only this call ever carries
 * ticket text. A failure never sinks the review: it is named in one line and the review goes on
 * without the coverage block. Returns undefined when no block can be shown.
 */
async function runRequirementsPass(params: {
  pr: BitbucketPR;
  ref: { project: string; repo: string };
  ticket: { ticketKey: string; source: RequirementsSource };
  fileDiffs: FileDiff[];
  service: PrReviewService;
  request: Pick<vscode.ChatRequest, 'model'>;
  token: vscode.CancellationToken;
  runTag: string;
  tokenBudget: number;
  fetchedFileCache: Map<string, string>;
  /** A goal the user stated; when set it replaces the ticket as the primary requirement. */
  userGoal?: string;
  /** Files of the PR that are not in `fileDiffs` at all (cut from a stored diff), counted as not seen. */
  alreadyOmittedPaths?: string[];
  logReview: (level: 'info' | 'warn' | 'error', message: string, details?: Record<string, unknown>) => void;
  stream: vscode.ChatResponseStream;
}): Promise<RequirementsCoverage | undefined> {
  const { pr, ref, ticket, fileDiffs, service, request, token, runTag, tokenBudget, fetchedFileCache, userGoal, alreadyOmittedPaths = [], logReview, stream } = params;
  stream.markdown(`_Checking the diff against ${ticket.ticketKey}…_\n\n`);
  try {
    const ticketText = formatRequirementsSourceText(ticket.source);
    const packBudget = Math.max(0, tokenBudget - Math.ceil(ticketText.length / 4) - REQUIREMENTS_PROMPT_OVERHEAD_TOKENS);
    const packed = packDiffFiles(fileDiffs, packBudget);
    const shown = packed.shown;
    const omitted: Array<{ path: string; changedLines?: number }> = [...packed.omitted, ...alreadyOmittedPaths.map((path) => ({ path }))];
    const prPaths = [...new Set([...fileDiffs.map((f) => f.path), ...alreadyOmittedPaths])];
    if (omitted.length > 0) {
      logReview('info', `Requirements pass sees ${shown.length} of ${prPaths.length} file(s)`, { runTag, omitted: omitted.map((o) => o.path) });
    }

    const callOnce = async (round: 1 | 2, fileContents?: Map<string, string>) => {
      const prompt = service.buildRequirementsPrompt(pr, ticket.ticketKey, ticketText, shown, {
        omittedFiles: omitted, ...(userGoal ? { userGoal } : {}), ...(fileContents ? { fileContents } : {}),
      });
      const attemptOut: CallAttemptOut = { attempt: 0, durationMs: 0 };
      const raw = await callLLMWithProgress(
        prompt, request.model, token, 'Checking requirements', `requirements round ${round}`,
        {
          attemptOut,
          onAttemptError: (attempt, durationMs, errorCode) => logReview('error', formatCallLine({
            runTag, pass: 'requirements', batch: 1, totalBatches: 1, attempt,
            itemCount: shown.length, promptChars: prompt.length, durationMs, status: 'error', errorCode,
          })),
        },
        (reply) => { parseRequirementsReply(reply, prPaths); },
      );
      logReview('info', formatCallLine({
        runTag, pass: 'requirements', batch: 1, totalBatches: 1, attempt: attemptOut.attempt,
        itemCount: shown.length, promptChars: prompt.length, responseChars: raw.length,
        durationMs: attemptOut.durationMs, status: 'ok',
      }));
      return parseRequirementsReply(raw, prPaths);
    };

    let parsed = await callOnce(1);
    if (parsed.additionalFilesNeeded.length > 0 && !parsed.noClearRequirements) {
      try {
        const context = await fetchAndBudgetContextFiles({
          requestedFiles: parsed.additionalFilesNeeded, fetchedFileCache, service,
          project: ref.project, repo: ref.repo, commitHash: pr.fromCommitHash, tokenBudget, budgetAgainst: shown,
          fetchMessage: (n) => `_Fetching ${n} file${n !== 1 ? 's' : ''} the requirements check asked for…_\n\n`,
          logLabel: 'Requirements context files', batchNum: 1, logReview, stream,
        });
        if (context.size > 0) parsed = await callOnce(2, context);
      } catch (err) {
        // One round only, and a failed second round keeps what the first one found.
        logReview('warn', 'Requirements extra-file round failed — keeping the first answer', {
          runTag, error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (parsed.droppedOutOfScope > 0) {
      logReview('info', `Requirements pass named ${parsed.droppedOutOfScope} file(s) outside the PR — dropped`, { runTag });
    }
    logReview('info', `Requirements coverage for ${ticket.ticketKey}`, {
      runTag, requirements: parsed.requirements.length, outOfScope: parsed.outOfScope.length,
      noClearRequirements: parsed.noClearRequirements, conflict: parsed.conflict !== undefined,
    });
    return buildCoverage(ticket.ticketKey, parsed, { unseenFileCount: omitted.length, ...(userGoal ? { userGoal } : {}) });
  } catch (err) {
    logDiag('bitbucket.review', 'error', `Requirements pass failed — [${runTag}]`, {
      runTag, error: err instanceof Error ? err.message : String(err), ...describeErrorForLog(err),
    });
    stream.markdown(`_⚠ The requirements check could not be completed (${(err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').slice(0, 160)}) — the review below is complete without it._\n\n`);
    return undefined;
  }
}

/**
 * KTD4/R5: one continuation call after a cut-off reply. Findings are ordered by severity, not by
 * file, so no file can be proven finished — the continuation re-reviews the whole batch and lists
 * what was already reported, asking only for findings not on that list. Throws when the call fails
 * after its retries; the caller keeps what the cut-off reply already produced.
 */
async function runContinuation(params: {
  pass: ReviewPass;
  files: FileDiff[];
  alreadyReported: Array<Omit<ReviewFinding, 'id'>>;
  buildPrompt: (alreadyReported: Array<Omit<ReviewFinding, 'id'>>) => string;
  batchNum: number;
  totalBatches: number;
  batchStatus: string;
  runTag: string;
  request: Pick<vscode.ChatRequest, 'model'>;
  token: vscode.CancellationToken;
  logReview: (level: 'info' | 'warn' | 'error', message: string, details?: Record<string, unknown>) => void;
  stream: vscode.ChatResponseStream;
}): Promise<{ reply: ParsedReviewReply }> {
  const { pass, files, alreadyReported, buildPrompt, batchNum, totalBatches, batchStatus, runTag, request, token, logReview, stream } = params;
  logReview('info', formatRecoveryDecision(runTag, { kind: 'continuation', batch: batchNum, totalBatches, fileCount: files.length }));
  stream.markdown(formatContinuationMessage(files.length));
  const prompt = buildPrompt(alreadyReported);
  const attemptOut: CallAttemptOut = { attempt: 0, durationMs: 0 };
  const raw = await callLLMWithProgress(
    prompt, request.model, token, `${batchStatus} continuation`,
    `${pass} continuation batch ${batchNum}/${totalBatches}`,
    {
      attemptOut,
      onAttemptError: (attempt, durationMs, errorCode) => logReview('error', formatCallLine({
        runTag, pass, batch: batchNum, totalBatches, attempt,
        itemCount: files.length, promptChars: prompt.length, durationMs, status: 'error', errorCode,
      })),
    },
    assertReadableReply,
  );
  const reply = parseReviewReply(raw);
  logReview('info', formatCallLine({
    runTag, pass, batch: batchNum, totalBatches, attempt: attemptOut.attempt,
    itemCount: files.length, promptChars: prompt.length, responseChars: raw.length,
    durationMs: attemptOut.durationMs, status: reply.truncated ? 'truncated' : 'ok',
  }));
  return { reply };
}

/**
 * U3/U7: run one persona lens pass per active persona over a single chunk's files —
 * the identical withEasierRetry → callLLMOnceWithProgress → resolveFindingAnchors
 * sequence pass1 uses, logged with `pass: '<persona-id>'`. Extracted into a standalone
 * function (rather than left inline in the per-chunk review loop) so three call sites
 * share one implementation instead of drifting apart: the deep-mode inline persona pass
 * (still per-chunk, behavior unchanged), smart mode's phase 2 (run once, after all
 * chunks' standard passes complete, over the same chunks), and the smart-fallback resume
 * path (`resumeSmartReviewPhase2`, a later chat turn with none of the main review's
 * local state in scope).
 */
async function runPersonaPassesForChunk(params: {
  personas: Persona[];
  chunk: FileDiff[];
  batchNum: number;
  totalBatches: number;
  pr: BitbucketPR;
  service: PrReviewService;
  extraInstructions: string;
  request: Pick<vscode.ChatRequest, 'model'>;
  token: vscode.CancellationToken;
  runTag: string;
  batchStatus: string;
  logReview: (level: 'info' | 'warn' | 'error', message: string, details?: Record<string, unknown>) => void;
  stream: vscode.ChatResponseStream;
}): Promise<{
  findings: Array<Omit<ReviewFinding, 'id'>>;
  rawCount: number;
  droppedOutsidePr: number;
  anyFailed: boolean;
  /** True when at least one persona batch got a readable reply — it counts as review, not as failure. */
  anySucceeded: boolean;
}> {
  const { personas, chunk, batchNum, totalBatches, pr, service, extraInstructions, request, token, runTag, batchStatus, logReview, stream } = params;
  let findings: Array<Omit<ReviewFinding, 'id'>> = [];
  let rawCount = 0;
  let droppedOutsidePr = 0;
  let anyFailed = false;
  let anySucceeded = false;

  for (const persona of personas) {
    const personaLabel = `${persona.id} batch ${batchNum}/${totalBatches}`;
    const personaTracker = createAttemptTracker<FileDiff>();
    let personaPromptChars = 0;
    const personaBatches = await withEasierRetry(
      chunk,
      async (files) => {
        const attempt = personaTracker.start(files);
        const prompt = service.buildPersonaPrompt(persona, pr, files, undefined, extraInstructions);
        personaPromptChars = prompt.length;
        const raw = await callLLMOnceWithProgress(prompt, request.model, token, batchStatus);
        assertReadableReply(raw);
        const status = parseReviewReply(raw).truncated ? 'truncated' : 'ok';
        logReview('info', formatCallLine({
          runTag, pass: persona.id, batch: batchNum, totalBatches, attempt,
          itemCount: files.length, promptChars: prompt.length, responseChars: raw.length,
          durationMs: personaTracker.elapsedMs(), status,
        }));
        return raw;
      },
      splitFilesInHalf,
      {
        onAttemptFailed: (attempt, err, files) => handleAttemptFailure({
          runTag, pass: persona.id, batch: batchNum, totalBatches,
          libraryAttempt: attempt, err, items: files, originalItems: chunk,
          tracker: personaTracker, promptChars: personaPromptChars, split: splitFilesInHalf,
          logFailure: (a, e) => logLmFailure(personaLabel, a, e, { files: files.map((f) => f.path) }),
          logReview,
        }),
      },
    );

    for (const batch of personaBatches) {
      if (batch.error !== undefined) {
        anyFailed = true;
        const filePaths = batch.items.map((f) => f.path).join(', ');
        stream.markdown(formatBatchFailureNotice({
          label: `${persona.displayName} pass — batch ${batchNum}`, filePaths, cause: describeFailure(batch.error), err: batch.error,
        }));
        continue;
      }
      anySucceeded = true;
      const { findings: batchFindings, truncated } = await parseReviewResponse(batch.result!);
      const pass1Resolved = resolveFindingAnchors(batchFindings, batch.items);
      let resolved = pass1Resolved.findings;
      rawCount += batchFindings.length;
      droppedOutsidePr += pass1Resolved.droppedOutsidePr;
      if (truncated) {
        stream.markdown(`_⚠ ${persona.displayName} pass reply was cut off (batch ${batchNum}) — recovering the rest._\n\n`);
        try {
          const cont = await runContinuation({
            pass: persona.id, files: batch.items, alreadyReported: resolved,
            buildPrompt: (reported) => service.buildPersonaPrompt(persona, pr, batch.items, undefined, extraInstructions, { alreadyReported: reported }),
            batchNum, totalBatches, batchStatus, runTag, request, token, logReview, stream,
          });
          const contResolved = resolveFindingAnchors(cont.reply.findings as Array<Omit<ReviewFinding, 'id'>>, batch.items);
          rawCount += cont.reply.findings.length;
          droppedOutsidePr += contResolved.droppedOutsidePr;
          resolved = [...resolved, ...contResolved.findings];
        } catch (err) {
          anyFailed = true;
          logReview('warn', `${persona.displayName} continuation failed — batch ${batchNum}`, { batch: batchNum, error: err instanceof Error ? err.message : String(err) });
          stream.markdown(`_⚠ ${persona.displayName} continuation failed (batch ${batchNum}) — keeping findings from the cut-off reply. ${describeFailure(err)}_\n\n`);
        }
      }
      // KTD4: stamp each persona-pass finding with its persona's id so the Source column and the
      // dedup corroboration bump can both rely on `sources` always being a real, populated array.
      // This is the single seam where pass identity is known.
      findings = findings.concat(resolved.map((f) => ({ ...f, sources: [persona.id] })));
    }
  }

  return { findings, rawCount, droppedOutsidePr, anyFailed, anySucceeded };
}

/** Token budget per review call: `modelContextTokens` setting → model API → fallback, × `contextBudgetRatio`. */
function resolveTokenBudget(
  config: BitbucketConfig,
  model: vscode.LanguageModelChat,
): { tokenBudget: number; resolvedContextTokens: number; budgetRatio: number } {
  const resolvedContextTokens = config.modelContextTokens
    ?? (model as unknown as { maxInputTokens?: number }).maxInputTokens
    ?? 60000;
  const budgetRatio = config.contextBudgetRatio ?? 0.7;
  return { tokenBudget: Math.floor(resolvedContextTokens * budgetRatio), resolvedContextTokens, budgetRatio };
}

async function handleCheck(
  stream: vscode.ChatResponseStream,
  config: BitbucketConfig,
  configService: ConfigService,
): Promise<void> {
  if (!configService.isBitbucketConfigured(config)) {
    const urlStatus = config.authType === 'cloud'
      ? 'n/a (Cloud)'
      : (config.baseUrl ? 'present' : '**absent** — add `ticketSidekick.bitbucket.baseUrl` to VS Code settings');
    const setupCommand = config.authType === 'cloud'
      ? 'ticket-sidekick.configureBitbucketCloud'
      : 'ticket-sidekick.setBitbucketDataCenterToken';
    const setupLabel = config.authType === 'cloud'
      ? 'Ticket Sidekick: Configure Bitbucket Cloud Credentials'
      : 'Ticket Sidekick: Set Bitbucket Personal Access Token';
    const notConfigured = new vscode.MarkdownString(
      '**Bitbucket not configured.**\n\n' +
      `| Setting | Status |\n|---|---|\n` +
      `| Auth type | ${config.authType} |\n` +
      `| Base URL | ${urlStatus} |\n` +
      `| Token | ${tokenStatus(config.token)} |\n\n` +
      `Run [${setupLabel}](command:${setupCommand}) from the chat, or find it in the Command Palette.`,
    );
    notConfigured.isTrusted = { enabledCommands: [setupCommand] };
    stream.markdown(notConfigured);
    return;
  }
  // For Data Center, a malformed baseUrl is a common misconfiguration — surface it clearly
  // before attempting a connection. (Cloud ignores baseUrl and talks to api.bitbucket.org.)
  if (config.authType === 'datacenter') {
    const urlError = validateBaseUrl(config.baseUrl);
    if (urlError) {
      stream.markdown(`**Bitbucket configuration problem**\n\n${urlError}`);
      return;
    }
  }
  const effectiveUrl = config.authType === 'cloud' ? 'https://api.bitbucket.org' : config.baseUrl!;
  const apiVersion = config.authType === 'cloud' ? 'v2.0' : 'v1.0';
  const displayUrl = effectiveUrl;
  try {
    const client = new BitbucketApiClient({
      baseUrl: config.baseUrl ?? '',
      authType: config.authType,
      token: config.token!,
      onDiag: (level, message, details) => logDiag('bitbucket.apiClient', level, message, details),
    });
    const user = await client.getCurrentUser();
    stream.markdown(
      `**Bitbucket connection OK**\n\n` +
      `| Setting | Value |\n|---|---|\n` +
      `| Base URL | \`${displayUrl}\` |\n` +
      `| API version | ${apiVersion} |\n` +
      `| Auth type | ${config.authType} |\n` +
      `| Token | ${tokenStatus(config.token)} |\n` +
      `| Logged in as | ${user.displayName} |\n`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logDiag('bitbucket.review', 'error', 'Bitbucket connection check failed', { baseUrl: config.baseUrl, authType: config.authType, error: message });
    stream.markdown(
      `**Bitbucket connection failed**\n\n` +
      `| Setting | Value |\n|---|---|\n` +
      `| Base URL | \`${displayUrl}\` |\n` +
      `| API version | ${apiVersion} |\n` +
      `| Auth type | ${config.authType} |\n` +
      `| Token | ${tokenStatus(config.token)} |\n\n` +
      `Error: ${message}`,
    );
  }
}

export function createBitbucketParticipant(
  context: vscode.ExtensionContext,
  configService: ConfigService,
): vscode.ChatParticipant {
  // One counter store per window; per-machine, kept for the current month and the two before it.
  const usageService = new TokenUsageService(context.globalState);
  // U5/R6: the handler returns `{ metadata: { bitbucketFollowup } }` from a major response so
  // `participant.followupProvider` below can compute the right suggestion chips for it — mirrors
  // `JiraParticipant.ts`'s own use of `vscode.ChatResult.metadata` for the same purpose. A bare
  // `return;` (still valid — `void` stays in the union) means "no chip-worthy state", e.g. a
  // multi-turn follow-up reply whose own response tag already carries the next-step guidance.
  const handler: vscode.ChatRequestHandler = async (
    request: vscode.ChatRequest,
    chatContext: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
  ): Promise<vscode.ChatResult | void> => {
    const prompt = request.prompt.trim();
    const config = await configService.getBitbucketConfig();

    // `check` and `usage` are neutral: they hand the active session's marker forward, so a live
    // review (or preview) survives them and their response shows the session's end chip.
    const historySession = getActiveBitbucketSession(chatContext);
    const neutralResult = (): vscode.ChatResult | undefined =>
      historySession && hasStoredBitbucketSession(historySession.kinds, context.workspaceState)
        ? { metadata: { bitbucketSession: historySession } }
        : undefined;

    // 1. check command — `/check` is the slash-command shortcut for this same check
    // (KTD12); `request.prompt` never includes the command name itself (confirmed
    // against vscode.ChatRequest's typings), so the regex below still only matches
    // plain-text "check".
    if (request.command === 'check' || /^check\b/i.test(prompt)) {
      await handleCheck(stream, config, configService);
      return neutralResult();
    }

    // `usage` reads local counters only — it works without Bitbucket credentials and runs before
    // session detection, so the bare word `usage` is always this command (KTD9).
    if (request.command === 'usage' || isUsageRequest(prompt)) {
      stream.markdown(formatUsageTable(usageService.snapshot(), new Date()));
      return neutralResult();
    }

    // Every model call in this response goes through the meter: it feeds the monthly usage
    // counters and, when `showTokenUsage` is on, the footer line.
    const meter = createTokenMeter(
      request.model,
      (modelId, figures) => usageService.record(modelId, figures),
      (level, message, details) => logDiag('bitbucket.tokenUsage', level, message, details),
    );
    const model = meter.model;
    const modelRequest = { model };
    // Logged on the review's opening lines: whether metering attached, and whether the host froze the model.
    const hostModelState = { metering: meter.metered ? 'on' : 'off', frozen: Object.isFrozen(request.model) };
    const appendTokenFooter = (budget?: number): void => {
      if (!config.showTokenUsage) return;
      const totals = meter.totals();
      if (totals.calls === 0) return;
      stream.markdown(`\n\n${formatTokenFooter({
        input: totals.input, output: totals.output, estimated: totals.estimated, modelId: meter.modelId, budget,
      })}`);
    };

    // U4/R5: `/review` needs no dispatch of its own — VS Code strips the command name
    // out of `request.prompt`, so `/review <url>` leaves `prompt` as exactly the PR URL
    // (or, with no URL, the same empty prompt a bare `@bitbucket` message would have),
    // which the existing prUrlMatch-driven flow below already handles unchanged —
    // including the "Point me at a PR to review" guidance when no URL is given.

    if (config.showConnectionInfo) {
      const effectiveUrl = config.authType === 'cloud' ? 'https://api.bitbucket.org' : (config.baseUrl ?? '(not set)');
      const apiVersion = config.authType === 'cloud' ? 'v2.0' : 'v1.0';
      stream.markdown(`_${effectiveUrl} · API ${apiVersion} · ${config.authType}_\n\n`);
    }

    const ws = context.workspaceState;
    // Code-review fix: docs/review-process.md documents hasPrUrl() as the PR-URL-bypass gate
    // (R1's "follow-ups"), but the boolean checks below used to re-derive their own regex here
    // instead of calling it — same input set today, but a doc/code drift waiting to diverge.
    // Boolean gates now call hasPrUrl(prompt); this match stays only for extracting the URL text
    // itself (prUrlMatch[0]) where a gate needs the matched substring, not just a yes/no.
    const prUrlMatch = prompt.match(/https?:\/\/\S+\/pull-requests\/\d+\S*/);

    // Helper: stream a comment preview and save session
    const streamCommentPreview = async (previewSession: BitbucketCommentPreviewSession): Promise<vscode.ChatResult> => {
      await ws.update('bitbucket.session.commentPreview', previewSession);
      const n = previewSession.items.length;
      const parts: string[] = [`**Preview: ${n} comment${n !== 1 ? 's' : ''} to post**`];
      const allInline = previewSession.items.every(i => i.finding.lineType !== undefined);
      for (const { finding, text } of previewSession.items) {
        const anchorLine = finding.lineType !== undefined
          ? `📌 _Inline comment on line ${finding.line} of \`${finding.file}\`_`
          : finding.line !== undefined
            ? `⚠️ _Line ${finding.line} could not be located in the diff — will fall back to activity feed comment_`
            : `⚠️ _No line number — will be posted to activity feed_`;
        parts.push(`---\n\n**#${finding.id}** — ${finding.title}\n${anchorLine}\n\n${text}`);
      }
      const postLabel = allInline ? 'post inline' : 'post to activity feed';
      // `parts` above includes each finding's LLM-generated comment text — derived from the PR's
      // own diff content, so untrusted — streamed as a plain (untrusted) string so a crafted
      // command-link inside it can't render as clickable. The confirm/cancel footer is a separate,
      // trusted `stream.markdown()` call so only this handler's own two fixed links are live (KTD5).
      stream.markdown(parts.join('\n\n'));
      stream.markdown(trustedChatMarkdown(
        `---\n\nReply ${buildChatCommandLink('Post it', '@bitbucket', 'post it')} to ${postLabel}, ` +
        `give a refinement instruction, or ${buildChatCommandLink('Cancel', '@bitbucket', 'cancel')}.`,
      ));
      return { metadata: { bitbucketSession: { kinds: ['comment-preview'] } } };
    };

    // Helper: post results and format report
    const postAndReport = async (previewSession: BitbucketCommentPreviewSession): Promise<vscode.ChatResult> => {
      await ws.update('bitbucket.session.commentPreview', undefined);
      stream.markdown(`_Posting ${previewSession.items.length} comment${previewSession.items.length !== 1 ? 's' : ''} to Bitbucket…_\n\n`);
      const client = new BitbucketApiClient({
        baseUrl: config.baseUrl ?? '',
        authType: config.authType,
        token: config.token!,
        onDiag: (level, message, details) => logDiag('bitbucket.apiClient', level, message, details),
      });
      const service = new PrReviewService(
        client,
        (level, message, details) => logDiag('bitbucket.prReviewService', level, message, details),
      );
      const results = await service.postCommentItems(
        previewSession.project, previewSession.repo, previewSession.prId, previewSession.items,
      );
      const successLines: string[] = [];
      const failureLines: string[] = [];
      for (const r of results) {
        if (r.result) {
          const ref = r.result.commentUrl
            ? `[comment #${r.result.commentId}](${r.result.commentUrl})`
            : `comment #${r.result.commentId}`;
          const anchor = r.finding.lineType !== undefined ? `inline on L${r.finding.line}` : 'activity feed';
          successLines.push(`- **#${r.finding.id}** ${r.finding.title} → posted as ${ref} (${anchor})`);
        } else {
          failureLines.push(`- **#${r.finding.id}** ${r.finding.title} → failed: ${r.error}`);
        }
      }
      let output = '';
      if (successLines.length > 0) output += `**Posted ${successLines.length} comment${successLines.length !== 1 ? 's' : ''}:**\n\n${successLines.join('\n')}\n\n`;
      if (failureLines.length > 0) output += `**Failed to post ${failureLines.length} comment${failureLines.length !== 1 ? 's' : ''}:**\n\n${failureLines.join('\n')}\n\n`;
      stream.markdown(output);
      return { metadata: { bitbucketSession: { kinds: ['review-session'] } } };
    };

    /**
     * KTD10: the one completion step every finished review goes through — the main review and the
     * smart-fallback resume alike — so the two can't drift apart: dedup, number, format, funnel,
     * partial-failure banner, dropped-findings notice, token estimate, stored session and chips.
     */
    const completeReview = async (params: {
      pr: BitbucketPR;
      ref: { prUrl: string; project: string; repo: string; prId: number };
      runTag: string;
      service: PrReviewService;
      logReview: (level: 'info' | 'warn' | 'error', message: string, details?: Record<string, unknown>) => void;
      allFindings: Array<Omit<ReviewFinding, 'id'>>;
      fileDiffs: FileDiff[];
      batchCount: number;
      tally: ReviewTally;
      tokenBudget: number;
      upfrontQuestion?: string;
      /** R7 (opt-in): the buffered per-call lines for the fenced structured record. */
      structuredRecord?: { configLine: string; lines: string[] };
      /** The ticket the requirements pass checks the diff against; absent unless the user opted in. */
      requirements?: { ticketKey: string; source: RequirementsSource };
      /** Files already fetched in this review, so the requirements pass never re-fetches one. */
      fetchedFileCache?: Map<string, string>;
      /** One line shown after the review when a ticket was spotted but not used (quick and standard). */
      ticketHintLine?: string;
    }): Promise<vscode.ChatResult> => {
      const { pr, ref, runTag, service, logReview, allFindings, fileDiffs, batchCount, tally, tokenBudget, upfrontQuestion } = params;
      // Collapse the same issue surfacing in multiple batches before numbering.
      const deduped = dedupeFindings(allFindings);
      const numbered = deduped.map((f, idx) => ({ ...f, id: idx + 1 }));
      // The requirements pass runs after every other pass, once the findings are final, so the smart
      // fallback resume gets it too. Its block goes above the findings tables; it adds no findings.
      const coverage = params.requirements
        ? await runRequirementsPass({
          pr, ref, ticket: params.requirements, fileDiffs, service, request: modelRequest, token, runTag, tokenBudget,
          fetchedFileCache: params.fetchedFileCache ?? new Map(), logReview, stream,
        })
        : undefined;
      const reviewResult = service.formatReview(
        numbered, pr, fileDiffs.length, config.confidenceThreshold, coverage ? renderCoverageMarkdown(coverage) : undefined,
      );
      logReview('info', `PR review completed — ${numbered.length} finding(s)`, {
        project: ref.project, repo: ref.repo, prId: ref.prId,
        findingCount: numbered.length, fileCount: fileDiffs.length, batchCount, anyBatchFailed: tally.anyBatchFailed,
        reviewedFileCount: tally.reviewedFileCount, failedFileCount: tally.failedFileCount,
      });

      // R6: findings funnel — where findings dropped and by which stage. KTD5/KTD6: no confidence
      // fold — every finding lands in a severity table, so `final` is the total finding count shown.
      const funnelSummary = formatFindingsFunnel({
        raw: tally.raw,
        dedupedCrossBatch: tally.dedupedEarlier + allFindings.length - deduped.length,
        droppedOutsidePr: tally.droppedOutsidePr,
        retractedByPass2: tally.retractedByPass2,
        final: reviewResult.primaryCount,
        unverified: numbered.filter((f) => f.locationUnverified).length,
        ...(tally.droppedByCritic !== undefined ? { droppedByCritic: tally.droppedByCritic } : {}),
      });
      logReview('info', funnelSummary);

      // R7 (opt-in): one fenced structured record for the whole run. logDiag truncates any single
      // `message` at MAX_STRING_LENGTH (500 chars), and this record is explicitly uncapped, so it's
      // logged one already-short line at a time instead of as one long message.
      if (params.structuredRecord) {
        for (const line of formatStructuredRunRecord({
          runTag, configLine: params.structuredRecord.configLine, lines: params.structuredRecord.lines, funnel: funnelSummary,
        }).split('\n')) {
          logDiag('bitbucket.review', 'info', line);
        }
      }
      if (tally.anyBatchFailed) {
        stream.markdown(PARTIAL_REVIEW_WARNING);
      }
      const droppedNotice = formatDroppedFindingsNotice({ outsidePr: tally.droppedOutsidePr, critic: tally.droppedByCritic ?? 0 });
      if (droppedNotice) stream.markdown(`${droppedNotice}\n\n`);
      stream.markdown(trustedChatMarkdown(composeReviewOutput(reviewResult)));
      if (params.ticketHintLine) stream.markdown(`\n\n${params.ticketHintLine}`);
      appendTokenFooter(tokenBudget);

      const storedDiff = buildStoredReviewDiff(fileDiffs, numbered, tokenBudget * 4);
      await ws.update('bitbucket.session.review', {
        prTitle: pr.title,
        prUrl: ref.prUrl,
        project: ref.project,
        repo: ref.repo,
        prId: ref.prId,
        findings: numbered,
        prDescription: pr.description,
        changedFiles: fileDiffs.map(d => ({ path: d.path, ...(d.deleted ? { deleted: true } : {}) })),
        upfrontQuestion,
        rawDiff: storedDiff.rawDiff,
        rawDiffTruncated: storedDiff.truncated,
        rawDiffOmittedFiles: storedDiff.omittedFiles,
        prAuthor: pr.author.displayName,
        prTargetBranch: pr.targetBranch,
        ...(coverage && params.requirements
          ? { requirements: { ticketKey: params.requirements.ticketKey, source: params.requirements.source, coverage } }
          : {}),
      } satisfies ReviewSession);
      // U7/KTD9: the Bitbucket Getting-Started walkthrough's "first PR review" step completes on
      // this context key — set only at a real review completion, never on an aborted run.
      await vscode.commands.executeCommand('setContext', 'ticketSidekick.firstReviewCompleted', true);
      // R6: "after a PR review: add findings to review, ask about a finding" — the follow-up chips.
      const reviewState: BitbucketFollowupState = { kind: 'reviewCompleted', findingCount: numbered.length };
      // bitbucketSession makes this review the active ReviewSession on the next turn.
      return { metadata: { bitbucketFollowup: reviewState, bitbucketSession: { kinds: ['review-session'] } } };
    };

    // U4/R7: smart-mode selection-failure fallback — called once persona-recommendation aggregation
    // finds no usable signal from any chunk. Stores a SmartFallbackSession (PR reference, fetched
    // diff, chunk boundaries, phase 1's findings, focus question and counters) and asks the user to
    // choose between running all four persona passes or continuing with the standard pass only.
    const askSmartFallbackChoice = async (fallbackSession: SmartFallbackSession): Promise<vscode.ChatResult> => {
      await ws.update('bitbucket.session.smartFallback', fallbackSession);
      stream.markdown(trustedChatMarkdown(
        `_Smart mode couldn't determine a persona recommendation for this PR from any diff chunk._\n\n` +
        `Reply ${buildChatCommandLink('All', '@bitbucket', 'all')} to run all four specialist passes ` +
        `(${PERSONAS.map(p => p.displayName).join(', ')}), or ${buildChatCommandLink('Standard', '@bitbucket', 'standard')} to continue with just the standard review.`,
      ));
      return { metadata: { bitbucketSession: { kinds: ['smart-fallback-session'] } } };
    };

    // U7/R23: resumes a smart-mode review whose fallback question fired — the user has now chosen
    // `all` or `standard`. Runs phase 2 over `session.chunks` with the same focus question the
    // original review had, then finishes through the shared completion step, exactly like an
    // uninterrupted review. This turn has none of the main handler's local state in scope, so it
    // rebuilds its own client/service/runTag.
    const resumeSmartReviewPhase2 = async (
      session: SmartFallbackSession,
      chosenPersonas: PersonaId[],
    ): Promise<vscode.ChatResult | void> => {
      await ws.update('bitbucket.session.smartFallback', undefined);
      const choiceLabel = chosenPersonas.length === 0
        ? 'the standard pass only'
        : `all four persona passes (${chosenPersonas.map((id) => PERSONAS.find((p) => p.id === id)?.displayName ?? id).join(', ')})`;
      stream.markdown(`_Resuming review of **${session.prTitle}** with ${choiceLabel}…_\n\n`);

      const runTag = buildRunTag(session.project, session.repo, session.prId);
      const client = new BitbucketApiClient({
        baseUrl: config.baseUrl ?? '',
        authType: config.authType,
        token: config.token!,
        onDiag: (level, message, details) => logDiag('bitbucket.apiClient', level, message, details),
      });
      const service = new PrReviewService(
        client,
        (level, message, details) => logDiag('bitbucket.prReviewService', level, message, details),
      );
      const logReview = (level: 'info' | 'warn' | 'error', message: string, details?: Record<string, unknown>): void => {
        logDiag('bitbucket.review', level, message, details);
      };
      const extraInstructions = [config.reviewInstructions, session.upfrontQuestion].filter(Boolean).join('\n\n');
      const { tokenBudget } = resolveTokenBudget(config, model);
      // Sessions stored before R23 carry no tally; start from phase 1's finding count rather than fail.
      const tally: ReviewTally = {
        ...(session.phase1Tally ?? {
          raw: session.phase1Findings.length, dedupedEarlier: 0, droppedOutsidePr: 0, retractedByPass2: 0,
          anyBatchFailed: false,
        }),
      };

      try {
        const pr = await client.getPullRequest(session.project, session.repo, session.prId);
        // Findings already carry an `id` (numbered when the fallback session was stored) —
        // dedupeFindings works on `Omit<ReviewFinding, 'id'>[]`, so strip it before merging.
        let allFindings: Array<Omit<ReviewFinding, 'id'>> = session.phase1Findings.map(
          ({ id: _id, ...rest }) => rest,
        );

        const selectedPersonas = PERSONAS.filter((p) => chosenPersonas.includes(p.id));
        for (let i = 0; i < session.chunks.length && selectedPersonas.length > 0; i++) {
          const batchStatus = session.chunks.length > 1 ? `Batch ${i + 1}/${session.chunks.length}` : 'Analysing';
          const personaResult = await runPersonaPassesForChunk({
            personas: selectedPersonas, chunk: session.chunks[i], batchNum: i + 1, totalBatches: session.chunks.length,
            pr, service, extraInstructions, request: modelRequest, token, runTag, batchStatus, logReview, stream,
          });
          tally.raw += personaResult.rawCount;
          tally.droppedOutsidePr += personaResult.droppedOutsidePr;
          if (personaResult.anyFailed) tally.anyBatchFailed = true;
          allFindings = allFindings.concat(personaResult.findings);
        }

        logReview('info', `Smart-fallback resume — ${selectedPersonas.length} persona pass(es) run`, { runTag, chosenPersonas });
        return await completeReview({
          pr, ref: { prUrl: session.prUrl, project: session.project, repo: session.repo, prId: session.prId },
          runTag, service, logReview, allFindings, fileDiffs: session.diffs, batchCount: session.chunks.length,
          tally, tokenBudget, upfrontQuestion: session.upfrontQuestion,
          ...(session.requirementsTicket ? { requirements: session.requirementsTicket } : {}),
        });
      } catch (err) {
        logDiag('bitbucket.review', 'error', `Smart-fallback resume failed — [${runTag}]`, {
          runTag, error: err instanceof Error ? err.message : String(err), ...describeErrorForLog(err),
        });
        stream.markdown(friendlyLmFailureMessage('**Review failed:**', err));
      }
    };

    // A `/review` or bare mode word with no PR URL is a review start with nothing to review: it
    // ends the old session instead of being answered as a follow-up question, and falls through
    // to the usual no-URL response below.
    const startsWithoutUrl = isReviewStartWithoutUrl(prompt, request.command);
    if (startsWithoutUrl) await endBitbucketSessions(ws);
    const activeSession = startsWithoutUrl ? undefined : historySession;

    // 2a. Comment preview — confirmation, cancellation, or refinement
    if (!hasPrUrl(prompt) && activeSession?.kinds.includes('comment-preview')) {
      const previewSession = ws.get<BitbucketCommentPreviewSession>('bitbucket.session.commentPreview');
      if (previewSession) {
        if (isEndSessionRequest(prompt)) {
          await ws.update('bitbucket.session.commentPreview', undefined);
          stream.markdown(`_Cancelled._`);
          return { metadata: { bitbucketSession: { kinds: ['review-session'] } } };
        }
        if (isConfirmation(prompt)) {
          return postAndReport(previewSession);
        }
        // Refinement — revise each comment text with the instruction, one LLM call per item
        try {
          const revisedItems: Array<{ finding: ReviewFinding; text: string }> = [];
          for (const item of previewSession.items) {
            const instruction = `Revise the following Bitbucket PR comment based on this instruction: "${prompt}"\n\nOriginal comment:\n${item.text}`;
            const revised = await generateContent(instruction, model, token, undefined, 'generate');
            revisedItems.push({ finding: item.finding, text: revised || item.text });
          }
          const result = await streamCommentPreview({ ...previewSession, items: revisedItems });
          appendTokenFooter();
          return result;
        } catch (err) {
          logDiag('bitbucket.followup', 'error', 'Comment refinement failed', { error: err instanceof Error ? err.message : String(err), ...describeErrorForLog(err) });
          stream.markdown(friendlyLmFailureMessage('**Refinement failed:**', err));
          return { metadata: { bitbucketSession: { kinds: ['comment-preview'] } } };
        }
      }
    }

    // 2a2. Smart-mode selection-failure fallback question (U4/R7) — detected ahead of the
    // ReviewSession follow-up check (2b) below, same detection-order discipline as 2a above.
    if (!hasPrUrl(prompt) && activeSession?.kinds.includes('smart-fallback-session')) {
      const fallbackSession = ws.get<SmartFallbackSession>('bitbucket.session.smartFallback');
      if (fallbackSession) {
        if (isEndSessionRequest(prompt)) {
          await ws.update('bitbucket.session.smartFallback', undefined);
          stream.markdown('_Fallback question cancelled — the review stops here._');
          return;
        }

        const choice = parseSmartFallbackReply(prompt);
        if (choice.kind === 'unrecognized') {
          stream.markdown(trustedChatMarkdown(
            `_Didn't catch that — reply ${buildChatCommandLink('All', '@bitbucket', 'all')} to run all four persona passes, ` +
            `or ${buildChatCommandLink('Standard', '@bitbucket', 'standard')} to continue with the standard review only._`,
          ));
          return { metadata: { bitbucketSession: { kinds: ['smart-fallback-session'] } } };
        }

        return resumeSmartReviewPhase2(fallbackSession, choice.personas);
      }
    }

    // 2b. Multi-turn follow-up on an existing review
    if (!hasPrUrl(prompt) && activeSession?.kinds.includes('review-session')) {
      const session = ws.get<ReviewSession>('bitbucket.session.review');
      if (session) {
        const reviewSessionResult: vscode.ChatResult = { metadata: { bitbucketSession: { kinds: ['review-session'] } } };

        if (isEndSessionRequest(prompt)) {
          await endBitbucketSessions(ws);
          stream.markdown('_Review session ended._');
          return;
        }

        try {
          const intent = parseFollowUpIntent(prompt, { hasRequirements: session.requirements !== undefined });

          if (intent.kind === 'goal') {
            // Only the requirements pass re-runs, against the stored diff, with the stated goal as the
            // primary requirement. Findings and their numbers are untouched; a failed redo keeps the old block.
            const stored = session.requirements!;
            if (!intent.goal) {
              stream.markdown('_Tell me the goal after "the goal is …" and I will check the PR against it._');
              return reviewSessionResult;
            }
            const goalClient = new BitbucketApiClient({
              baseUrl: config.baseUrl ?? '',
              authType: config.authType,
              token: config.token!,
              onDiag: (level, message, details) => logDiag('bitbucket.apiClient', level, message, details),
            });
            const goalService = new PrReviewService(
              goalClient,
              (level, message, details) => logDiag('bitbucket.prReviewService', level, message, details),
            );
            const goalRunTag = buildRunTag(session.project, session.repo, session.prId);
            const goalPr = await goalClient.getPullRequest(session.project, session.repo, session.prId);
            const coverage = await runRequirementsPass({
              pr: goalPr, ref: { project: session.project, repo: session.repo },
              ticket: { ticketKey: stored.ticketKey, source: stored.source },
              fileDiffs: parseDiff(session.rawDiff ?? ''), service: goalService, request: modelRequest, token, runTag: goalRunTag,
              tokenBudget: resolveTokenBudget(config, model).tokenBudget, fetchedFileCache: new Map(), userGoal: intent.goal,
              alreadyOmittedPaths: session.rawDiffOmittedFiles ?? [],
              logReview: (level, message, details) => logDiag('bitbucket.review', level, message, details), stream,
            });
            if (!coverage) return reviewSessionResult;
            await ws.update('bitbucket.session.review', { ...session, requirements: { ...stored, coverage } } satisfies ReviewSession);
            stream.markdown(trustedChatMarkdown(renderCoverageMarkdown(coverage)));
            appendTokenFooter();
            return reviewSessionResult;
          }

          if (intent.kind === 'copy') {
            // "Copy for Teams": plain text on the local clipboard only (R9) — nothing is posted.
            const targets = intent.targets === 'all' ? undefined : intent.targets;
            const unknownRef = targets?.find((id) => !session.findings.some((f) => f.id === id));
            if (unknownRef !== undefined) {
              stream.markdown(
                `_Finding #${unknownRef} not found. The review has findings #1–#${session.findings.length}._`,
              );
              return reviewSessionResult;
            }
            const share = formatReviewForSharing(session, {
              targets,
              confidenceThreshold: config.confidenceThreshold,
              ...(session.requirements ? { coverageText: renderCoverageText(session.requirements.coverage) } : {}),
            });
            try {
              await vscode.env.clipboard.writeText(share.text);
            } catch (err) {
              logDiag('bitbucket.share', 'error', 'Copying the review to the clipboard failed', { error: err instanceof Error ? err.message : String(err) });
              stream.markdown(`**Could not copy the review:** ${err instanceof Error ? err.message : String(err)}`);
              return reviewSessionResult;
            }
            logDiag('bitbucket.share', 'info', 'Review copied to the clipboard', { copiedCount: share.copiedCount, totalCount: share.totalCount });
            stream.markdown(`_Copied ${share.countLabel} to the clipboard — paste into a Teams chat._`);
            return reviewSessionResult;
          }

          if (intent.kind === 'add') {
            if (!session.project || !session.repo || !session.prId) {
              stream.markdown(`_Session is from an older version — start a new review to use "add to review"._`);
              return reviewSessionResult;
            }
            const selectedFindings = intent.targets === 'all'
              ? session.findings
              : session.findings.filter((f) => (intent.targets as number[]).includes(f.id));
            if (selectedFindings.length === 0) {
              stream.markdown(`_No matching findings. Use **#N** references or **add all to review**._`);
              return reviewSessionResult;
            }
            const userNote = intent.note || undefined;
            const service = new PrReviewService(
              new BitbucketApiClient({
                baseUrl: config.baseUrl ?? '',
                authType: config.authType,
                token: config.token!,
                onDiag: (level, message, details) => logDiag('bitbucket.apiClient', level, message, details),
              }),
              (level, message, details) => logDiag('bitbucket.prReviewService', level, message, details),
            );
            const items = selectedFindings.map(f => ({ finding: f, text: service.formatPrComment(f, userNote) }));
            const previewSession: BitbucketCommentPreviewSession = {
              project: session.project, repo: session.repo, prId: session.prId, items,
            };
            return streamCommentPreview(previewSession);
          }

          // intent.kind === 'explain'
          let finding: ReviewFinding | undefined;

          if (intent.findingRef != null) {
            finding = session.findings.find((f) => f.id === intent.findingRef);
            if (!finding) {
              stream.markdown(
                `_Finding #${intent.findingRef} not found. The review has findings #1–#${session.findings.length}._`,
              );
              return reviewSessionResult;
            }
          } else {
            const matchPrompt =
              `The developer asked: "${intent.question}"\n\n` +
              `Available findings:\n${session.findings.map((f) => `#${f.id}: [${f.severity}] ${f.title} (${f.file})`).join('\n')}\n\n` +
              `Reply with ONLY the finding number (e.g. "2") that best matches the question, or "none" if no match.`;
            const matchRaw = await callLLMWithProgress(matchPrompt, model, token, 'Matching finding', 'follow-up match');
            const num = parseFindingMatchReply(matchRaw);
            finding = num === undefined ? undefined : session.findings.find((f) => f.id === num);
          }

          if (!finding) {
            // General PR-level question — no specific finding matched
            const { tokenBudget } = resolveTokenBudget(config, model);
            const prContextPrompt = session.rawDiff
              ? buildDiffAwarePrompt(session, intent.question, tokenBudget * 4)
              : buildPrContextPrompt(session, intent.question);
            const prAnswer = await callLLMWithProgress(prContextPrompt, model, token, 'Answering question', 'follow-up pr-answer');
            stream.markdown(prAnswer);
            appendTokenFooter();
            return reviewSessionResult;
          }

          const followUpPrompt = buildFindingFollowUpPrompt(session, finding, intent.question);

          const answer = await callLLMWithProgress(followUpPrompt, model, token, 'Explaining finding', 'follow-up explain');
          stream.markdown(`**Finding #${finding.id} — ${finding.title}**\n\n${answer}`);
          appendTokenFooter();
          return reviewSessionResult;

        } catch (err) {
          logDiag('bitbucket.followup', 'error', 'Follow-up handling failed', { error: err instanceof Error ? err.message : String(err), ...describeErrorForLog(err) });
          stream.markdown(friendlyLmFailureMessage('**Follow-up failed:**', err));
          return reviewSessionResult;
        }
      }
    }

    // 3. New review. Keeps the `prUrlMatch`-based check (not `hasPrUrl(prompt)`) deliberately —
    // this early return is what lets TypeScript narrow `prUrlMatch` to non-null for every use
    // below (parsePrUrl(prUrlMatch[0]), etc.); the hasPrUrl() consolidation applies to the
    // bypass gates above, which only ever need a boolean.
    if (!prUrlMatch) {
      // U5/R9: an empty invocation or an obvious greeting/help-shaped prompt gets a friendlier
      // orientation message, with its example next step delivered as a follow-up chip (KTD14)
      // rather than repeated as inline prose — checked here, after both multi-turn session-tag
      // branches above, so a session already in flight always wins (same ordering rule @jira's
      // greeting check follows). A prompt that isn't a greeting still falls through to the
      // existing "Point me at a PR" guidance unchanged — @bitbucket has no LLM intent classifier
      // for an R8-equivalent "unrecognized operation" fallback to reroute (see reviewSessionState.ts).
      if (isGreetingOrEmpty(prompt)) {
        stream.markdown(
          '**@bitbucket** reviews Bitbucket pull requests — paste a PR URL to get started ' +
          '(`@bitbucket https://bitbucket.company.com/projects/PROJ/repos/myrepo/pull-requests/42`), ' +
          'or try the suggestion below.',
        );
        const greetingState: BitbucketFollowupState = { kind: 'greeting' };
        return { metadata: { bitbucketFollowup: greetingState } };
      }
      stream.markdown(
        'Point me at a PR to review — paste the URL right after `@bitbucket`:\n\n' +
        '`@bitbucket https://bitbucket.company.com/projects/PROJ/repos/myrepo/pull-requests/42`\n\n' +
        'Optionally add a focus question: `@bitbucket <url> -- Did I introduce any regression?`\n\n' +
        'Not sure what to do? Type `@bitbucket help`.',
      );
      return;
    }

    if (!configService.isBitbucketConfigured(config)) {
      const setupCommand = config.authType === 'cloud'
        ? 'ticket-sidekick.configureBitbucketCloud'
        : 'ticket-sidekick.setBitbucketDataCenterToken';
      const setupLabel = config.authType === 'cloud'
        ? 'Ticket Sidekick: Configure Bitbucket Cloud Credentials'
        : 'Ticket Sidekick: Set Bitbucket Personal Access Token';
      const notConfigured = new vscode.MarkdownString(
        `**Bitbucket not configured.**\n\nRun [${setupLabel}](command:${setupCommand}) from the chat, or find it in the Command Palette.`,
      );
      notConfigured.isTrusted = { enabledCommands: [setupCommand] };
      stream.markdown(notConfigured);
      return;
    }

    const parsed = parsePrUrl(prUrlMatch[0]);
    if (!parsed) {
      stream.markdown(`Could not parse PR URL: \`${prUrlMatch[0]}\``);
      return;
    }
    // A PR URL starts a fresh review, so a stored preview or fallback question from an earlier
    // one must not outlive it.
    await endBitbucketSessions(ws);
    // Two @bitbucket reviews can run concurrently in one VS Code window, sharing one
    // output channel — every diagnostic line for this run carries this tag (KTD1).
    const runTag = buildRunTag(parsed.project, parsed.repo, parsed.prId);

    const client = new BitbucketApiClient({
      baseUrl: config.baseUrl ?? '',
      authType: config.authType,
      token: config.token!,
      onDiag: (level, message, details) => logDiag('bitbucket.apiClient', level, message, details),
    });
    const service = new PrReviewService(
      client,
      (level, message, details) => logDiag('bitbucket.prReviewService', level, message, details),
    );

    // KTD9: last stage reached before the run ended, so an aborted/thrown-out-of run
    // is distinguishable in the output channel from a channel-write failure — the
    // funnel's absence alone is ambiguous otherwise. Declared outside `try` so the
    // catch block below can still read it.
    let lastStage = 'setup';
    try {
      // The question, an explicit ticket key and `no ticket` come out of the prompt first, so a
      // question containing "deep"/"quick" (or a key like DEEP-1) can't flip the review mode.
      const directives = extractPromptDirectives(prompt);
      const upfrontQuestion = directives.question;
      // Detect quick/deep mode keyword from what remains (overrides setting).
      const promptWithoutUrl = directives.remainder.toLowerCase();
      // Widened 4-value mode (quick < standard < smart < deep by capability), resolved with
      // deep > smart > quick > configured-default detection precedence (KTD1). `resolvedMode`
      // is the single source of truth later units read to decide which personas are active.
      const resolvedMode = resolveReviewMode(promptWithoutUrl, config.reviewMode ?? 'standard');
      const reviewMode = resolvedMode;
      // The critic (verification) pass is opt-in via "deep" — it roughly doubles per-chunk cost.
      const criticEnabled = deriveCriticEnabled(resolvedMode);
      const extraInstructions = [config.reviewInstructions, upfrontQuestion].filter(Boolean).join('\n\n');

      // Resolve token budget: user setting → model API → safe fallback
      const { tokenBudget, resolvedContextTokens, budgetRatio } = resolveTokenBudget(config, model);

      // R3: one opening line recording the effective run configuration, so a
      // misconfigured token budget/ratio is visible without re-running the review.
      const configLine =
        `${runTag} model=${model.vendor}/${model.family} tokenBudget=${tokenBudget} ` +
        `(resolved=${resolvedContextTokens} ratio=${budgetRatio}) reviewMode=${reviewMode} ` +
        `criticEnabled=${criticEnabled} contextLines=${config.reviewContextLines ?? 12}`;

      // R7 (opt-in): buffer every diagnostic line so one fenced structured record can be
      // assembled at end of run. Off by default — skip buffering entirely so the default
      // path adds no measurable overhead.
      const detailedDiagnostics = config.detailedDiagnostics ?? false;
      const recordedLines: string[] = [];
      // `details` is rendered through the same sanitizeDetails() redaction/truncation
      // logDiag applies, so the structured record never carries anything the always-on
      // channel line wouldn't have shown.
      const record = (line: string, details?: Record<string, unknown>): void => {
        if (!detailedDiagnostics) return;
        recordedLines.push(details ? `${line} ${JSON.stringify(sanitizeDetails(details))}` : line);
      };
      // Every review-pipeline diagnostic line goes through this instead of logDiag
      // directly, so it's always both written to the output channel and (when the
      // opt-in setting is on) captured into the end-of-run structured record.
      const logReview = (level: 'info' | 'warn' | 'error', message: string, details?: Record<string, unknown>): void => {
        logDiag('bitbucket.review', level, message, details);
        record(message, details);
      };
      record(configLine);

      logReview('info', `Review started — ${runTag}`, {
        runTag,
        vendor: model.vendor,
        family: model.family,
        id: model.id,
        resolvedContextTokens,
        contextBudgetRatio: budgetRatio,
        // Named budgetTokens, not tokenBudget — isSensitiveKey redacts the standalone
        // word "token" (singular), and "tokens" (plural, as in resolvedContextTokens)
        // reads the same to an operator without tripping it.
        budgetTokens: tokenBudget,
        reviewMode,
        criticEnabled,
        reviewContextLines: config.reviewContextLines ?? 12,
        ...hostModelState,
      });

      // R6: findings-funnel counters. Tallied exactly once per per-file batch, on
      // whichever raw/resolved pair actually settles after the truncation/pass-2
      // branches run (see the `batchRawCount` comment at its declaration below) — an
      // earlier version tallied at every resolveFindingAnchors call instead, which
      // double-counted a batch's original findings whenever continuation or pass2
      // superseded them.
      let rawFindingsTotal = 0;
      let droppedOutsidePrTotal = 0;
      let retractedByPass2Total = 0;
      let criticDroppedTotal = 0;

      if (upfrontQuestion) {
        stream.markdown(`_focus: ${upfrontQuestion}_\n\n`);
      }
      lastStage = 'fetching PR';
      stream.markdown('_Fetching PR…_\n\n');
      const pr = await client.getPullRequest(parsed.project, parsed.repo, parsed.prId);

      // What to do about a Jira ticket is decided now that the PR title is known (see requirementsFlow.ts).
      // Smart and deep ask first when the title names a ticket; the choice comes back as a full re-run
      // of this command, so nothing is stored while the user decides.
      const jiraConfig = await configService.getConfig();
      const ticketStep = decideTicketStep({
        mode: reviewMode,
        explicitKey: directives.ticketKey,
        skipTicket: directives.skipTicket,
        titleKey: extractTicketId(pr.title) ?? undefined,
        jiraConfigured: configService.isConfigured(jiraConfig),
      });
      logReview('info', `Ticket step — ${ticketStep.kind}`, { runTag, step: ticketStep.kind, ...('key' in ticketStep ? { key: ticketStep.key } : {}) });
      let requirementsTicket: { ticketKey: string; source: RequirementsSource } | undefined;
      let ticketHintLine: string | undefined;
      switch (ticketStep.kind) {
        case 'ask':
          stream.markdown(trustedChatMarkdown(buildTicketPause(ticketStep.key, prompt)));
          return;
        case 'run': {
          if (!configService.isConfigured(jiraConfig)) break;
          const ticketService = new TicketService(
            new JiraApiClient({
              baseUrl: jiraConfig.baseUrl,
              authType: jiraConfig.authType,
              token: jiraConfig.token,
              onDiag: (level, message, details) => logDiag('jira.apiClient', level, message, details),
            }),
            (level, message, details) => logDiag('jira.ticketService', level, message, details),
          );
          const read = await ticketService.getRequirementsSource(ticketStep.key);
          if (read.ok) {
            requirementsTicket = { ticketKey: ticketStep.key, source: read.source };
            stream.markdown(`_Using ticket ${ticketStep.key} to check requirements._\n\n`);
          } else {
            stream.markdown(`${buildTicketFailureLine(ticketStep.key, read)}\n\n`);
          }
          break;
        }
        case 'hint':
          ticketHintLine = buildTicketHintLine(ticketStep.key, prUrlMatch[0]);
          break;
        case 'ignored-explicit':
          stream.markdown(`${buildIgnoredTicketLine(ticketStep.key)}\n\n`);
          break;
        case 'not-configured':
          stream.markdown(`${buildNotConfiguredLine(ticketStep.key)}\n\n`);
          break;
        case 'no-key':
          stream.markdown(`${buildNoKeyLine()}\n\n`);
          break;
        default:
          break;
      }

      logReview('info', 'model in use', {
        vendor: model.vendor,
        family: model.family,
        id: model.id,
        version: model.version,
        maxInputTokens: model.maxInputTokens,
        ...hostModelState,
      });
      // Widen surrounding context (default 12) so the reviewer sees the enclosing code,
      // not just the changed lines. Applies in quick mode too — only Pass 2 is skipped there.
      const coverage = await client.getPullRequestDiffWithCoverage(parsed.project, parsed.repo, parsed.prId, config.reviewContextLines);
      // Apply exclusion patterns before chunking
      let fileDiffs = parseDiff(coverage.raw);

      const excludePatterns = config.reviewExcludePatterns ?? [];

      // R17: Data Center cuts very large diffs short. Fetch each cut file on its own and put its
      // diff in place of whatever part of it (if any) made it into the PR diff. A cut file matching
      // `excludePatterns` is dropped below anyway, so it is neither fetched nor warned about.
      const cutFilesToRecover = coverage.cutFiles.filter(
        (cut) => !excludePatterns.some((p) => minimatch(cut.path, p, { matchBase: true })),
      );
      if (cutFilesToRecover.length > 0) {
        lastStage = 'recovering cut files';
        const n = cutFilesToRecover.length;
        stream.markdown(`_The server cut this PR's diff short — fetching ${n} file${n !== 1 ? 's' : ''} individually…_\n\n`);
        logReview('warn', `PR diff truncated by the server — recovering ${n} file(s)`, {
          runTag, cutFiles: cutFilesToRecover.map((c) => c.path),
        });
        const partial: string[] = [];
        const unrecovered: string[] = [];
        for (const cut of cutFilesToRecover) {
          if (token.isCancellationRequested) break;
          try {
            const recovered = await client.getPullRequestFileDiff(
              parsed.project, parsed.repo, parsed.prId, cut.path, config.reviewContextLines, cut.srcPath,
            );
            const pieces = parseDiff(recovered.raw);
            if (pieces.length === 0) throw new Error('the server returned no diff for this file');
            fileDiffs = [...fileDiffs.filter((d) => d.path !== cut.path), ...pieces];
            if (recovered.truncated) partial.push(cut.path);
          } catch (err) {
            unrecovered.push(cut.path);
            logReview('warn', `Could not fetch cut file ${cut.path}`, { runTag, path: cut.path, error: err instanceof Error ? err.message : String(err) });
          }
        }
        if (partial.length > 0) {
          stream.markdown(`_⚠ Still cut short by the server, reviewed partially: ${partial.join(', ')}._\n\n`);
        }
        if (unrecovered.length > 0) {
          stream.markdown(`_⚠ ${unrecovered.join(', ')} could not be fetched and ${unrecovered.length === 1 ? 'was' : 'were'} not reviewed._\n\n`);
        }
      }

      // Files with no hunks carry no reviewable text (binary, pure rename, or mode-only).
      // Deletions DO have hunks (removed lines), so they pass this filter and are reviewed.
      const noHunkCount = fileDiffs.filter(d => !d.diff.includes('@@ ')).length;
      if (noHunkCount > 0) {
        fileDiffs = fileDiffs.filter(d => d.diff.includes('@@ '));
        stream.markdown(`_${noHunkCount} file${noHunkCount !== 1 ? 's' : ''} with no textual diff (binary, rename, or mode-only) skipped._\n\n`);
      }

      let excludedCount = 0;
      if (excludePatterns.length > 0) {
        const before = fileDiffs.length;
        fileDiffs = fileDiffs.filter(
          (d) => !excludePatterns.some((p) => minimatch(d.path, p, { matchBase: true })),
        );
        excludedCount = before - fileDiffs.length;
      }

      if (fileDiffs.length === 0) {
        stream.markdown('_No files to review after applying exclusion patterns._\n\n');
        return;
      }

      if (excludedCount > 0) {
        stream.markdown(`_${excludedCount} file${excludedCount !== 1 ? 's' : ''} excluded by pattern._\n\n`);
      }

      const chunks = buildAdaptiveChunks(fileDiffs, tokenBudget);

      let allFindings: Array<Omit<ReviewFinding, 'id'>> = [];
      let fileOffset = 0;
      // Session-level cache so a file requested in batch 2 isn't re-fetched in batch 5.
      const fetchedFileCache = new Map<string, string>();

      const halveFindings = (
        items: Array<Omit<ReviewFinding, 'id'>>,
      ): [Array<Omit<ReviewFinding, 'id'>>, Array<Omit<ReviewFinding, 'id'>>] => {
        const mid = Math.ceil(items.length / 2);
        return [items.slice(0, mid), items.slice(mid)];
      };

      let anyBatchFailed = false;
      // KTD3: "failed" is a count, not the boolean above. Files in pass-1 batches that did / did not get a
      // readable reply feed the reported counts; a persona batch with a reply only keeps the review from
      // counting as failed (personas re-run the same files, so they never add to the counts).
      let reviewedFileCount = 0;
      let failedFileCount = 0;
      let firstFailure: string | undefined;
      let anyPersonaSucceeded = false;

      // One entry per chunk, populated only in `smart` mode — each chunk's standard pass's
      // own recommendation, or `undefined` when the call failed or the trailer's
      // recommendedPersonas field was missing/unparseable — aggregated after the loop below.
      const smartPersonaResults: Array<string[] | undefined> = [];

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const from = fileOffset + 1;
        const to = fileOffset + chunk.length;
        fileOffset += chunk.length;
        const batchLabel = chunks.length > 1 ? ` · batch ${i + 1}/${chunks.length}` : '';
        stream.markdown(`_Analysing files ${from}–${to} of ${fileDiffs.length}${batchLabel}…_\n\n`);

        const batchStatus = chunks.length > 1 ? `Batch ${i + 1}/${chunks.length}` : 'Analysing';
        const pass1Label = `pass1 batch ${i + 1}/${chunks.length}`;
        lastStage = `batch ${i + 1}/${chunks.length} pass1`;
        logReview('info', `Batch ${i + 1}/${chunks.length} started — ${chunk.length} file(s)`, {
          batch: i + 1, totalBatches: chunks.length, fileCount: chunk.length,
        });

        const pass1Tracker = createAttemptTracker<FileDiff>();
        let pass1PromptChars = 0;
        const pass1Batches = await withEasierRetry(
          chunk,
          async (files) => {
            const attempt = pass1Tracker.start(files);
            const prompt = service.buildPrompt(pr, files, undefined, extraInstructions, resolvedMode === 'smart');
            pass1PromptChars = prompt.length;
            const raw = await callLLMOnceWithProgress(prompt, model, token, batchStatus);
            assertReadableReply(raw);
            const status = parseReviewReply(raw).truncated ? 'truncated' : 'ok';
            logReview('info', formatCallLine({
              runTag, pass: 'pass1', batch: i + 1, totalBatches: chunks.length, attempt,
              itemCount: files.length, promptChars: prompt.length, responseChars: raw.length,
              durationMs: pass1Tracker.elapsedMs(), status,
            }));
            return raw;
          },
          splitFilesInHalf,
          {
            onAttemptFailed: (attempt, err, files) => handleAttemptFailure({
              runTag, pass: 'pass1', batch: i + 1, totalBatches: chunks.length,
              libraryAttempt: attempt, err, items: files, originalItems: chunk,
              tracker: pass1Tracker, promptChars: pass1PromptChars, split: splitFilesInHalf,
              logFailure: (a, e) => logLmFailure(pass1Label, a, e, { files: files.map((f) => f.path) }),
              logReview,
            }),
          },
        );

        let chunkFindings: Array<Omit<ReviewFinding, 'id'>> = [];
        // R10: context files Pass 2 used anywhere in this chunk — the critic judges with the same ones.
        const chunkContextPaths = new Set<string>();
        // U7/R4: smart mode's phase-1 recommendation signal for this chunk — usable once
        // any batch's trailer parsed (hasMetaLine), unioning recommendedPersonas across
        // batches (a chunk split by retry-halving may answer in more than one batch).
        let chunkPersonaUsable = false;
        const chunkRecPersonas = new Set<string>();

        for (const batch of pass1Batches) {
          if (batch.error !== undefined) {
            anyBatchFailed = true;
            failedFileCount += batch.items.length;
            const filePaths = batch.items.map((f) => f.path).join(', ');
            const cause = describeFailure(batch.error);
            firstFailure ??= cause;
            stream.markdown(formatBatchFailureNotice({ label: `Batch ${i + 1}`, filePaths, cause, err: batch.error }));
            continue;
          }
          reviewedFileCount += batch.items.length;

          const { findings, additionalFilesNeeded, truncated, hasMetaLine, danglingTail, recommendedPersonas } =
            await parseReviewResponse(batch.result!);
          if (resolvedMode === 'smart' && hasMetaLine) {
            chunkPersonaUsable = true;
            for (const p of recommendedPersonas ?? []) chunkRecPersonas.add(p);
          }
          // R6: `batchRawCount` tracks whichever raw findings set is CURRENTLY the one
          // that will feed this batch's final result — reassigned, not accumulated, as
          // continuation/pass2 supersede the earlier attempt. Tallying at every
          // resolveFindingAnchors call (instead of once, below, on the settled result)
          // would count raw findings a later pass fully discards, inflating the funnel's
          // "raw" total past what any downstream stage could ever have seen.
          let batchRawCount = findings.length;
          const pass1Resolved = resolveFindingAnchors(findings, batch.items);
          let batchOutsidePr = pass1Resolved.droppedOutsidePr;
          let batchRetracted = 0;
          let batchFindings = pass1Resolved.findings;

          let filesNeeded = additionalFilesNeeded;
          if (truncated) {
            // R4: the one event in the pipeline that previously threw nothing and
            // logged nothing — record what came back before recovering.
            const coveredPaths = new Set(findings.map(f => f.file));
            const truncationEvent = buildTruncationEvent({
              runTag, batch: i + 1, totalBatches: chunks.length, raw: batch.result!,
              parsedFindingsCount: findings.length, hasMetaLine: hasMetaLine ?? false,
              danglingTail,
              coveredFiles: [...coveredPaths],
              uncoveredFiles: batch.items.filter(d => !coveredPaths.has(d.path)).map((d) => d.path),
            });
            logReview('warn', truncationEvent.message, truncationEvent.details);
            stream.markdown(`_⚠ LLM response truncated (batch ${i + 1}) — recovering the rest._\n\n`);
            try {
              const cont = await runContinuation({
                pass: 'continuation', files: batch.items, alreadyReported: batchFindings,
                buildPrompt: (reported) => service.buildPrompt(
                  pr, batch.items, undefined, extraInstructions, resolvedMode === 'smart', { alreadyReported: reported },
                ),
                batchNum: i + 1, totalBatches: chunks.length, batchStatus, runTag, request: modelRequest, token, logReview, stream,
              });
              // The cut-off reply never reached its meta line, so the continuation's is this
              // batch's only chance to contribute a smart-mode persona recommendation.
              if (resolvedMode === 'smart' && cont.reply.hasMetaLine) {
                chunkPersonaUsable = true;
                for (const p of cont.reply.recommendedPersonas) chunkRecPersonas.add(p);
              }
              filesNeeded = [...new Set([...filesNeeded, ...cont.reply.additionalFilesNeeded])];
              const contRaw = cont.reply.findings as Array<Omit<ReviewFinding, 'id'>>;
              const contResolved = resolveFindingAnchors(contRaw, batch.items);
              batchRawCount += contRaw.length;
              batchOutsidePr += contResolved.droppedOutsidePr;
              batchFindings = [...batchFindings, ...contResolved.findings];
            } catch (err) {
              anyBatchFailed = true;
              logReview('warn', `Continuation pass failed — batch ${i + 1}`, { batch: i + 1, error: err instanceof Error ? err.message : String(err) });
              stream.markdown(`_⚠ Continuation pass failed (batch ${i + 1}) — keeping findings from the truncated response. ${describeFailure(err)}_\n\n`);
            }
          }

          if (reviewMode !== 'quick' && filesNeeded.length > 0) {
            try {
              // Fetch only files not already pulled in an earlier batch (cross-chunk cache),
              // bounded by a high per-batch ceiling — no longer a flat 5. A large PR pulls
              // many context files across its batches, each fetched at most once. Include as
              // many requested files as fit this chunk's remaining budget, smallest-first.
              const extraContents = await fetchAndBudgetContextFiles({
                requestedFiles: filesNeeded, fetchedFileCache, service,
                project: parsed.project, repo: parsed.repo, commitHash: pr.fromCommitHash,
                tokenBudget, budgetAgainst: batch.items,
                fetchMessage: (n) => `_Fetching ${n} context file${n !== 1 ? 's' : ''}${chunks.length > 1 ? ` (batch ${i + 1})` : ''}…_\n\n`,
                logLabel: 'Additional context files fetched', batchNum: i + 1, logReview, stream,
              });
              if (extraContents.size > 0) {
                for (const path of extraContents.keys()) chunkContextPaths.add(path);
                // KTD5: Pass 2 sees Pass 1's findings and refines them rather than replacing them.
                const pass2Prompt = service.buildPrompt(
                  pr, batch.items, extraContents, extraInstructions, false, { priorFindings: batchFindings },
                );
                const pass2Attempt: CallAttemptOut = { attempt: 0, durationMs: 0 };
                const pass2Raw = await callLLMWithProgress(
                  pass2Prompt, model, token, `${batchStatus} pass 2`,
                  `pass2 batch ${i + 1}/${chunks.length}`,
                  {
                    attemptOut: pass2Attempt,
                    onAttemptError: (attempt, durationMs, errorCode) => logReview('error', formatCallLine({
                      runTag, pass: 'pass2', batch: i + 1, totalBatches: chunks.length, attempt,
                      itemCount: batch.items.length, promptChars: pass2Prompt.length, durationMs, status: 'error', errorCode,
                    })),
                  },
                  assertReadableReply,
                );
                const pass2 = parseReviewReply(pass2Raw);
                logReview('info', formatCallLine({
                  runTag, pass: 'pass2', batch: i + 1, totalBatches: chunks.length, attempt: pass2Attempt.attempt,
                  itemCount: batch.items.length, promptChars: pass2Prompt.length, responseChars: pass2Raw.length,
                  durationMs: pass2Attempt.durationMs, status: pass2.truncated ? 'truncated' : 'ok',
                }));
                if (pass2.truncated) {
                  stream.markdown(`_⚠ LLM response truncated (batch ${i + 1} pass 2) — keeping the first-pass findings plus what Pass 2 returned._\n\n`);
                }
                const pass2Raw2 = pass2.findings as Array<Omit<ReviewFinding, 'id'>>;
                const pass2Resolved = resolveFindingAnchors(pass2Raw2, batch.items);
                const merged = mergePass2Findings(batchFindings, pass2Resolved.findings, pass2.retract);
                if (merged.invalidRetractions.length > 0) {
                  logReview('warn', `Pass 2 retracted unknown finding number(s) — ignored — batch ${i + 1}`, {
                    batch: i + 1, invalidRetractions: merged.invalidRetractions, pass1Count: batchFindings.length,
                  });
                }
                batchRawCount += pass2Raw2.length;
                batchOutsidePr += pass2Resolved.droppedOutsidePr;
                batchRetracted += merged.retracted;
                batchFindings = merged.findings;
              }
            } catch (err) {
              anyBatchFailed = true;
              logReview('warn', `Pass 2 (whole-file context) failed — batch ${i + 1}`, { batch: i + 1, error: err instanceof Error ? err.message : String(err) });
              stream.markdown(`_⚠ Pass 2 (whole-file context) failed (batch ${i + 1}) — keeping the first-pass findings. ${describeFailure(err)}_\n\n`);
            }
          }

          // Tally once per batch, after continuation and Pass 2 have settled.
          rawFindingsTotal += batchRawCount;
          droppedOutsidePrTotal += batchOutsidePr;
          retractedByPass2Total += batchRetracted;
          // KTD4: stamp standard-pass (phase 1) findings with the literal 'general' tag so they
          // carry an explicit `sources` array like persona findings — `'general'` is a real
          // SourceTag that participates in the dedup sources union, not just a display fallback.
          chunkFindings = chunkFindings.concat(batchFindings.map((f) => ({ ...f, sources: ['general'] })));
        }

        if (resolvedMode === 'smart') {
          smartPersonaResults.push(chunkPersonaUsable ? [...chunkRecPersonas] : undefined);
        }

        // U3/U5: deep mode's persona lens passes run inline, per-chunk, right here (unchanged
        // from before this unit). Smart mode's persona passes do NOT run in this loop — R4
        // requires aggregating every chunk's recommendation first, so smart mode's phase 2
        // runs once, after this whole per-chunk loop, over the same `chunks` (see below).
        const activePersonas: Persona[] = resolvedMode === 'deep' ? PERSONAS : [];
        if (activePersonas.length > 0) {
          const personaResult = await runPersonaPassesForChunk({
            personas: activePersonas, chunk, batchNum: i + 1, totalBatches: chunks.length,
            pr, service, extraInstructions, request: modelRequest, token, runTag, batchStatus, logReview, stream,
          });
          rawFindingsTotal += personaResult.rawCount;
          droppedOutsidePrTotal += personaResult.droppedOutsidePr;
          if (personaResult.anyFailed) anyBatchFailed = true;
          if (personaResult.anySucceeded) anyPersonaSucceeded = true;
          chunkFindings = chunkFindings.concat(personaResult.findings);
        }

        // Deep mode only: re-verify findings against the diff and drop the ones the critic can't confirm.
        if (criticEnabled && chunkFindings.length > 0) {
          lastStage = `batch ${i + 1}/${chunks.length} critic`;
          const criticLabel = `critic batch ${i + 1}/${chunks.length}`;
          const criticTracker = createAttemptTracker<Omit<ReviewFinding, 'id'>>();
          let criticPromptChars = 0;
          const criticBatches = await withEasierRetry(
            chunkFindings,
            async (findingsSubset) => {
              const attempt = criticTracker.start(findingsSubset);
              const referencedPaths = new Set(findingsSubset.map((f) => f.file));
              const relevantDiffs = chunk.filter((d) => referencedPaths.has(d.path));
              // R10: judge with the same context files Pass 2 used for this chunk.
              const { selected: criticContext } = selectFilesWithinBudget(
                [...chunkContextPaths].filter((p) => fetchedFileCache.has(p)).map((p) => ({ path: p, content: fetchedFileCache.get(p)! })),
                Math.max(0, tokenBudget - estimateChunkTokens(relevantDiffs)),
              );
              const prompt = service.buildCriticPrompt(
                pr, relevantDiffs, findingsSubset, extraInstructions, criticContext.size > 0 ? criticContext : undefined,
              );
              criticPromptChars = prompt.length;
              const raw = await callLLMOnceWithProgress(prompt, model, token, `${batchStatus} verifying`);
              logReview('info', formatCallLine({
                runTag, pass: 'critic', batch: i + 1, totalBatches: chunks.length, attempt,
                itemCount: findingsSubset.length, promptChars: prompt.length, responseChars: raw.length,
                durationMs: criticTracker.elapsedMs(), status: 'ok',
              }));
              return raw;
            },
            halveFindings,
            {
              onAttemptFailed: (attempt, err, findingsSubset) => handleAttemptFailure({
                runTag, pass: 'critic', batch: i + 1, totalBatches: chunks.length,
                libraryAttempt: attempt, err, items: findingsSubset, originalItems: chunkFindings,
                tracker: criticTracker, promptChars: criticPromptChars, split: halveFindings,
                logFailure: (a, e) => logLmFailure(criticLabel, a, e, { findingTitles: findingsSubset.map((f) => f.title) }),
                logReview,
              }),
            },
          );

          const verified: Array<Omit<ReviewFinding, 'id'>> = [];
          let droppedByCritic = 0;
          for (const batch of criticBatches) {
            if (batch.error !== undefined) {
              anyBatchFailed = true;
              stream.markdown(
                `_⚠ Critic verification for batch ${i + 1} didn't complete for ${batch.items.length} finding${batch.items.length !== 1 ? 's' : ''} — keeping ${batch.items.length !== 1 ? 'them' : 'it'} unverified. ${describeFailure(batch.error)}_\n\n`,
              );
              verified.push(...batch.items); // fail-soft: keep unverified rather than drop
              continue;
            }

            // R9/KTD4: give the critic one extra round to pull real files it needs to
            // confirm/refute a candidate finding, reusing the same fetch/cache/budget
            // machinery pass1→pass2 already uses. Capped at one round — the second-round
            // prompt tells the model this is final, so its `keep` decision settles here
            // even if it asks for more.
            let criticRaw = batch.result!;
            const requestedFiles = parseCriticAdditionalFiles(criticRaw);
            if (requestedFiles.length > 0) {
              try {
                const referencedPaths = new Set(batch.items.map((f) => f.file));
                const relevantDiffs = chunk.filter((d) => referencedPaths.has(d.path));
                // Round 2 keeps Pass 2's context alongside the newly requested files (R10).
                const extraContents = await fetchAndBudgetContextFiles({
                  requestedFiles: [...new Set([...chunkContextPaths, ...requestedFiles])], fetchedFileCache, service,
                  project: parsed.project, repo: parsed.repo, commitHash: pr.fromCommitHash,
                  tokenBudget, budgetAgainst: relevantDiffs,
                  fetchMessage: (n) => `_Fetching ${n} context file${n !== 1 ? 's' : ''} for critic verification (batch ${i + 1})…_\n\n`,
                  logLabel: 'Critic context files fetched', batchNum: i + 1, logReview, stream,
                });
                if (extraContents.size > 0) {
                  const finalRoundNote =
                    'This is the final verification round — no further files will be provided. ' +
                    'Decide "keep" using only the files you now have.';
                  const round2Instructions = extraInstructions
                    ? `${finalRoundNote}\n${extraInstructions}`
                    : finalRoundNote;
                  const round2Prompt = service.buildCriticPrompt(
                    pr, relevantDiffs, batch.items, round2Instructions, extraContents,
                  );
                  const round2Attempt: CallAttemptOut = { attempt: 0, durationMs: 0 };
                  const round2Raw = await callLLMWithProgress(
                    round2Prompt, model, token, `${batchStatus} verifying (round 2)`,
                    `critic round2 batch ${i + 1}/${chunks.length}`,
                    {
                      attemptOut: round2Attempt,
                      onAttemptError: (attempt, durationMs, errorCode) => logReview('error', formatCallLine({
                        runTag, pass: 'critic-r2', batch: i + 1, totalBatches: chunks.length, attempt,
                        itemCount: batch.items.length, promptChars: round2Prompt.length, durationMs, status: 'error', errorCode,
                      })),
                    },
                  );
                  // Only trust round 2 when its verdict is readable. A successful-but-garbled
                  // reply must not replace round 1's real keep decision with an unreadable one.
                  if (parseCriticKeep(round2Raw, batch.items.length) !== null) {
                    criticRaw = round2Raw;
                    logReview('info', formatCallLine({
                      runTag, pass: 'critic-r2', batch: i + 1, totalBatches: chunks.length, attempt: round2Attempt.attempt,
                      itemCount: batch.items.length, promptChars: round2Prompt.length, responseChars: round2Raw.length,
                      durationMs: round2Attempt.durationMs, status: 'ok',
                    }));
                  } else {
                    logReview('warn', `Critic round 2 returned no readable verdict — keeping round 1's decision — batch ${i + 1}`, {
                      batch: i + 1, responseChars: round2Raw.length,
                    });
                  }
                }
              } catch (err) {
                logReview('warn', `Critic file-fetch round failed — batch ${i + 1}`, {
                  batch: i + 1, error: err instanceof Error ? err.message : String(err),
                });
                // fail-soft: fall back to the first-round response's keep decision
              }
            }

            const keep = parseCriticKeep(criticRaw, batch.items.length);
            if (keep === null) {
              // R11: an unreadable verdict must neither wipe nor mis-keep findings — keep them all, unverified.
              anyBatchFailed = true;
              logReview('warn', `Critic verdict unreadable — keeping ${batch.items.length} finding(s) unverified — batch ${i + 1}`, {
                batch: i + 1, responseChars: criticRaw.length,
              });
              stream.markdown(
                `_⚠ Critic verification for batch ${i + 1} returned an unreadable verdict — keeping ${batch.items.length} finding${batch.items.length !== 1 ? 's' : ''} unverified._\n\n`,
              );
              verified.push(...batch.items);
              continue;
            }
            batch.items.forEach((f, idx) => {
              if (keep.has(idx + 1)) verified.push(f);
              else droppedByCritic++;
            });
          }
          criticDroppedTotal += droppedByCritic;
          if (droppedByCritic > 0) {
            logReview('info', `Critic dropped ${droppedByCritic} unverified finding(s) — batch ${i + 1}`, { batch: i + 1, droppedByCritic });
            stream.markdown(`_Critic dropped ${droppedByCritic} unverified finding${droppedByCritic !== 1 ? 's' : ''} (batch ${i + 1})._\n\n`);
          }
          chunkFindings = verified;
        }

        allFindings = allFindings.concat(chunkFindings);
        lastStage = `batch ${i + 1}/${chunks.length} done`;

        if (chunks.length > 1 && i < chunks.length - 1) {
          const crit = chunkFindings.filter((f) => f.severity === 'critical').length;
          const warn = chunkFindings.filter((f) => f.severity === 'warning').length;
          const sugg = chunkFindings.filter((f) => f.severity === 'suggestion').length;
          const tally = [
            crit ? `${crit} 🔴` : '',
            warn ? `${warn} 🟡` : '',
            sugg ? `${sugg} 🔵` : '',
          ].filter(Boolean).join(' · ') || 'no issues';
          stream.markdown(`_Batch ${i + 1}/${chunks.length} done · ${tally}_\n\n`);
        }
      }

      // R4/R5: nothing was reviewed — say so instead of finishing as a review that found nothing. This
      // follows the abort path's contract (no stored session, no walkthrough signal, no chips), and it
      // runs before smart mode's persona question, which would otherwise ask about a review that never ran.
      if (reviewedFileCount === 0 && !anyPersonaSucceeded) {
        logReview('error', `Review failed — no file could be reviewed — ${runTag}`, {
          runTag, fileCount: fileDiffs.length, batchCount: chunks.length, reviewedFileCount, failedFileCount, firstFailure,
        });
        stream.markdown(formatReviewFailedMessage({ fileCount: fileDiffs.length, cause: firstFailure ?? 'unknown' }));
        return;
      }

      // U7/R4/R6/R7: smart mode's phase 2 — run once, after every chunk's standard pass
      // (phase 1, the loop above) has returned, over the SAME chunks, for the PR-wide
      // aggregated persona set (never per-chunk — see the note above the loop).
      if (resolvedMode === 'smart') {
        const { selected, hasUsableSignal } = aggregateRecommendedPersonas(smartPersonaResults);

        if (!hasUsableSignal) {
          // R7/AE3: no chunk returned a usable recommendation — surface the choice to the
          // user instead of guessing. Number phase 1's findings now (the fallback session
          // stores them fully formed) and return early; `resumeSmartReviewPhase2` (a later
          // turn) runs phase 2 and streams the completed review.
          const phase1Deduped = dedupeFindings(allFindings);
          const phase1Numbered = phase1Deduped.map((f, idx) => ({ ...f, id: idx + 1 }));
          logReview('info', 'Smart mode: no usable persona recommendation from any chunk — asking user', { runTag });
          return askSmartFallbackChoice({
            prTitle: pr.title, prUrl: prUrlMatch[0], project: parsed.project, repo: parsed.repo, prId: parsed.prId,
            diffs: fileDiffs, chunks, phase1Findings: phase1Numbered, upfrontQuestion,
            phase1Tally: {
              raw: rawFindingsTotal, dedupedEarlier: allFindings.length - phase1Deduped.length,
              droppedOutsidePr: droppedOutsidePrTotal, retractedByPass2: retractedByPass2Total,
              anyBatchFailed, reviewedFileCount, failedFileCount,
            },
            ...(requirementsTicket ? { requirementsTicket } : {}),
          });
        }

        const selectedPersonas = PERSONAS.filter((p) => selected.includes(p.id));
        logReview('info', `Smart mode: personas selected — ${selectedPersonas.map((p) => p.id).join(', ') || '(none)'}`, {
          runTag, selected,
        });
        stream.markdown(
          selectedPersonas.length > 0
            ? `_Smart mode selected specialist lenses: **${selectedPersonas.map((p) => p.displayName).join(', ')}**._\n\n`
            : `_Smart mode found no specialist lens recommended for this PR — continuing with the standard review only._\n\n`,
        );

        if (selectedPersonas.length > 0) {
          for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            const batchStatus = chunks.length > 1 ? `Batch ${i + 1}/${chunks.length}` : 'Analysing';
            lastStage = `smart phase 2 batch ${i + 1}/${chunks.length}`;
            const personaResult = await runPersonaPassesForChunk({
              personas: selectedPersonas, chunk, batchNum: i + 1, totalBatches: chunks.length,
              pr, service, extraInstructions, request: modelRequest, token, runTag, batchStatus, logReview, stream,
            });
            rawFindingsTotal += personaResult.rawCount;
            droppedOutsidePrTotal += personaResult.droppedOutsidePr;
            if (personaResult.anyFailed) anyBatchFailed = true;
            allFindings = allFindings.concat(personaResult.findings);
          }
        }
      }

      return await completeReview({
        pr, ref: { prUrl: prUrlMatch[0], project: parsed.project, repo: parsed.repo, prId: parsed.prId },
        runTag, service, logReview, allFindings, fileDiffs, batchCount: chunks.length,
        tally: {
          raw: rawFindingsTotal, dedupedEarlier: 0, droppedOutsidePr: droppedOutsidePrTotal,
          retractedByPass2: retractedByPass2Total, ...(criticEnabled ? { droppedByCritic: criticDroppedTotal } : {}),
          anyBatchFailed, reviewedFileCount, failedFileCount,
        },
        tokenBudget, upfrontQuestion,
        ...(requirementsTicket ? { requirements: requirementsTicket, fetchedFileCache } : {}),
        ...(ticketHintLine ? { ticketHintLine } : {}),
        ...(detailedDiagnostics ? { structuredRecord: { configLine, lines: recordedLines } } : {}),
      });
    } catch (err) {
      // KTD9: name the last stage reached, so this is distinguishable from a run that
      // silently never got here (e.g. a channel-write failure) — the funnel's absence
      // alone can't tell those apart.
      logDiag('bitbucket.review', 'error', `Review aborted — [${runTag}] last stage: ${lastStage}`, {
        runTag, lastStage, error: err instanceof Error ? err.message : String(err), ...describeErrorForLog(err),
      });
      stream.markdown(friendlyLmFailureMessage('**Review failed:**', err));
    }
  };

  const participant = vscode.chat.createChatParticipant('ticket-sidekick.bitbucket', handler);
  // U5/R6: follow-up suggestion chips for the response `result` was just returned from —
  // `result.metadata.bitbucketFollowup` is set above wherever the handler has chip-worthy
  // state, and `bitbucketSession` adds the end-session chips for a live session; no metadata
  // (a bare `return;`) means no chips, e.g. after the session was ended.
  participant.followupProvider = {
    provideFollowups(result: vscode.ChatResult): vscode.ChatFollowup[] {
      const meta = result.metadata as
        { bitbucketFollowup?: BitbucketFollowupState; bitbucketSession?: BitbucketSessionContinuity } | undefined;
      // End-session chips come from the session kind, so every response that keeps a session
      // alive carries them without its own return site having to ask.
      return computeBitbucketFollowups(meta?.bitbucketFollowup ?? { kind: 'none' }, meta?.bitbucketSession?.kinds)
        .map((s) => ({ prompt: s.prompt, label: s.label }));
    },
  };
  context.subscriptions.push(participant);
  return participant;
}
