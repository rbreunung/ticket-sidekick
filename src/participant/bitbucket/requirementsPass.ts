import type { LogLevel } from '../../utils/diagTypes';
import type { BitbucketPR } from '../../bitbucket/IBitbucketClient';
import type { PrReviewService } from '../../services/PrReviewService';
import { formatRequirementsSourceText, type RequirementsTicket } from '../../utils/requirementsSource';
import { formatCallLine, type FileDiff } from '../reviewSessionState';
import { describeErrorForLog, type CallAttemptOut, type CallDiagHooks } from './reviewDiagnostics';
import { parseRequirementsReply, buildCoverage, packDiffFiles, type RequirementsCoverage } from './requirementsCoverage';

// `vscode`-free: the model call, the extra-file fetch and the chat stream arrive as parameters, so the
// whole pass (packing, the one extra-file round, failure wording) is covered by Vitest.

/** Tokens reserved for the instructions, PR text and reply when packing diff files into the requirements prompt. */
const REQUIREMENTS_PROMPT_OVERHEAD_TOKENS = 800;

export interface RequirementsPassParams {
  pr: BitbucketPR;
  ticket: RequirementsTicket;
  fileDiffs: FileDiff[];
  service: PrReviewService;
  runTag: string;
  tokenBudget: number;
  /** A goal the user stated; when set it replaces the ticket as the primary requirement. */
  userGoal?: string;
  /** Files of the PR that are not in `fileDiffs` at all (cut from a stored diff), counted as not seen. */
  alreadyOmittedPaths?: string[];
  logReview: (level: LogLevel, message: string, details?: Record<string, unknown>) => void;
  stream: { markdown(text: string): void };
}

export interface RequirementsPassDeps {
  /** One model call with the retry and unreadable-reply handling; `validateReply` throws on a reply with no usable JSON. */
  callModel: (prompt: string, round: 1 | 2, diag: CallDiagHooks, validateReply: (raw: string) => void) => Promise<string>;
  /** Fetches (through the review's shared cache) and budgets the extra files the model asked for. */
  fetchContextFiles: (requestedFiles: string[], shown: FileDiff[]) => Promise<Map<string, string>>;
  isCancelled: () => boolean;
}

/**
 * The requirements pass: one call over the whole PR (not per chunk) comparing the diff with the
 * ticket, plus at most one round of extra files the model asks for. Only this call ever carries
 * ticket text. A failure never sinks the review: it is named in one line and the review goes on
 * without the coverage block (returns undefined). A cancelled request is rethrown so it ends the
 * review like it does in every other pass.
 */
export async function runRequirementsPass(params: RequirementsPassParams, deps: RequirementsPassDeps): Promise<RequirementsCoverage | undefined> {
  const { pr, ticket, fileDiffs, service, runTag, tokenBudget, userGoal, alreadyOmittedPaths = [], logReview, stream } = params;
  stream.markdown(`_Checking the diff against ${ticket.ticketKey}…_\n\n`);
  try {
    const ticketText = formatRequirementsSourceText(ticket.source);
    const packBudget = Math.max(0, tokenBudget - Math.ceil(ticketText.length / 4) - REQUIREMENTS_PROMPT_OVERHEAD_TOKENS);
    const { shown, omitted: packedOmitted } = packDiffFiles(fileDiffs, packBudget);
    const omitted: Array<{ path: string; changedLines?: number }> = [...packedOmitted, ...alreadyOmittedPaths.map((path) => ({ path }))];
    const prPaths = [...new Set([...fileDiffs.map((f) => f.path), ...alreadyOmittedPaths])];
    if (omitted.length > 0) {
      logReview('info', `Requirements pass sees ${shown.length} of ${prPaths.length} file(s)`, { runTag, omitted: omitted.map((o) => o.path) });
    }

    const callOnce = async (round: 1 | 2, fileContents?: Map<string, string>) => {
      const prompt = service.buildRequirementsPrompt(pr, ticket.ticketKey, ticketText, shown, {
        omittedFiles: omitted, ...(userGoal ? { userGoal } : {}), ...(fileContents ? { fileContents } : {}),
      });
      const attemptOut: CallAttemptOut = { attempt: 0, durationMs: 0 };
      const raw = await deps.callModel(
        prompt, round,
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
        const context = await deps.fetchContextFiles(parsed.additionalFilesNeeded, shown);
        if (context.size > 0) parsed = await callOnce(2, context);
      } catch (err) {
        if (deps.isCancelled()) throw err;
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
    if (deps.isCancelled()) throw err;
    logReview('error', `Requirements pass failed — [${runTag}]`, {
      runTag, error: err instanceof Error ? err.message : String(err), ...describeErrorForLog(err),
    });
    stream.markdown(`_⚠ The requirements check could not be completed (${(err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').slice(0, 160)}) — the review below is complete without it._\n\n`);
    return undefined;
  }
}
