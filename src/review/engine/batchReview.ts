import type { BitbucketPR } from '../../bitbucket/IBitbucketClient';
import type { PrReviewService } from '../../services/PrReviewService';
import { refusalOf, type Refusal } from '../../utils/lmRetry';
import { formatBatchFailureText } from '../reviewDiagnostics';
import {
  buildTruncationEvent,
  formatRecoveryDecision,
  mergePass2Findings,
  parseReviewReply,
  resolveFindingAnchors,
  type FileDiff,
  type ReviewFinding,
  type ReviewPass,
  type SourceTag,
} from '../reviewSessionState';
import {
  assertReadableReply,
  callBatchWithSplit,
  callWithRetry,
  describeError,
  fetchAndBudgetContextFiles,
  isStop,
  type PassContext,
} from './plumbing';

// One batch of a review pass: the first call (retried, then split in half), the continuation of a
// cut-off reply, and one more call with the whole files the model asked for. The regular pass and
// the persona passes share it; only the prompt differs. vscode-free.

type Finding = Omit<ReviewFinding, 'id'>;

export interface BatchReviewParams {
  ctx: PassContext;
  service: PrReviewService;
  pr: BitbucketPR;
  target: { project: string; repo: string };
  commit: string;
  files: FileDiff[];
  label: string;
  /** The pass and batch the diagnostic lines name; the first call of a regular batch is `pass1`. */
  pass: ReviewPass;
  batch: number;
  totalBatches: number;
  source: SourceTag;
  /** The prompt asked for findings that go against the background; without it a reply's mark is dropped. */
  keepAgainstGoal: boolean;
  /** Builds the prompt; `contents` are the whole files to show, `options` the earlier findings. */
  buildPrompt: (files: FileDiff[], contents: Map<string, string> | undefined, options?: { priorFindings?: Finding[]; alreadyReported?: Finding[] }) => string;
  /** Files already read for this batch (the stored context of a later pass); shown on the first call. */
  initialContext?: Map<string, string>;
  /** Files read in this run, so a file is fetched at most once. */
  cache: Map<string, string>;
  tokenBudget: number;
}

export interface BatchReviewResult {
  findings: Finding[];
  /** Whole files the calls showed, by path; the batch's context for later passes. */
  contextPaths: string[];
  /** Persona ids recommended, when any reply carried the meta line; undefined when none did. */
  recommendedPersonas?: string[];
  reviewedFiles: number;
  failedFiles: number;
  failures: string[];
  /** Findings the replies gave, before anything was dropped, retracted or merged. */
  rawCount: number;
  /** Findings dropped because they named a file outside the pull request. */
  droppedOutsidePr: number;
  /** First findings the call with whole files retracted. */
  retracted: number;
  /** The model refused a call of the batch; no further call of the batch was made after it. */
  refusal?: Refusal;
}

/** Reviews one batch. A stop throws; every other failure is reported in the result. */
export async function reviewBatch(p: BatchReviewParams): Promise<BatchReviewResult> {
  const { ctx, files, label, batch, totalBatches } = p;
  const initial = p.initialContext && p.initialContext.size > 0 ? p.initialContext : undefined;
  const anchorOptions = { keepAgainstGoal: p.keepAgainstGoal };
  const parts = await callBatchWithSplit(ctx, {
    items: files, pass: p.pass, batch, totalBatches, label,
    buildPrompt: (items) => p.buildPrompt(items, initial),
    validate: assertReadableReply,
    statusOf: (raw) => (parseReviewReply(raw).truncated ? 'truncated' : 'ok'),
    failureDetails: (items) => ({ files: items.map((f) => f.path) }),
  });

  const result: BatchReviewResult = {
    findings: [], contextPaths: initial ? [...initial.keys()] : [], reviewedFiles: 0, failedFiles: 0, failures: [],
    rawCount: 0, droppedOutsidePr: 0, retracted: 0,
  };
  let anyMeta = false;
  const recommended = new Set<string>();
  // A refused part means the model takes no more calls now: no continuation or whole-file call follows.
  for (const part of parts) {
    const refusal = part.error !== undefined ? refusalOf(part.error) : undefined;
    if (refusal) { result.refusal = refusal; break; }
  }
  const noteRefusal = (err: unknown) => { const refusal = refusalOf(err); if (refusal) result.refusal ??= refusal; };

  for (const part of parts) {
    if (part.error !== undefined) {
      result.failedFiles += part.items.length;
      result.failures.push(formatBatchFailureText({
        label, filePaths: part.items.map((f) => f.path).join(', '), cause: describeError(part.error), err: part.error,
      }));
      continue;
    }
    result.reviewedFiles += part.items.length;
    const reply = parseReviewReply(part.result!);
    if (reply.hasMetaLine) { anyMeta = true; reply.recommendedPersonas.forEach((id) => recommended.add(id)); }
    const first = resolveFindingAnchors(reply.findings as Finding[], part.items, anchorOptions);
    let partFindings = first.findings;
    let rawCount = reply.findings.length;
    let droppedOutsidePr = first.droppedOutsidePr;
    let retracted = 0;
    let filesNeeded = reply.additionalFilesNeeded;

    if (reply.truncated && !result.refusal) {
      const covered = new Set(reply.findings.map((f) => f.file));
      const event = buildTruncationEvent({
        runTag: ctx.runTag, batch, totalBatches, raw: part.result!, parsedFindingsCount: reply.findings.length, hasMetaLine: reply.hasMetaLine,
        ...(reply.danglingTail !== undefined ? { danglingTail: reply.danglingTail } : {}),
        coveredFiles: [...covered].filter((f): f is string => typeof f === 'string'),
        uncoveredFiles: part.items.filter((d) => !covered.has(d.path)).map((d) => d.path),
      });
      ctx.log('warn', event.message, event.details);
      ctx.log('info', formatRecoveryDecision(ctx.runTag, { kind: 'continuation', batch, totalBatches, fileCount: part.items.length }));
      try {
        const cont = parseReviewReply(await callWithRetry(
          ctx, p.buildPrompt(part.items, initial, { alreadyReported: partFindings }), `${label} continuation`, assertReadableReply,
          { site: { pass: 'continuation', batch, totalBatches, itemCount: part.items.length } },
        ));
        if (cont.hasMetaLine) { anyMeta = true; cont.recommendedPersonas.forEach((id) => recommended.add(id)); }
        filesNeeded = [...new Set([...filesNeeded, ...cont.additionalFilesNeeded])];
        const resolved = resolveFindingAnchors(cont.findings as Finding[], part.items, anchorOptions);
        rawCount += cont.findings.length;
        droppedOutsidePr += resolved.droppedOutsidePr;
        partFindings = [...partFindings, ...resolved.findings];
      } catch (err) {
        if (isStop(err, ctx.signal)) throw err;
        noteRefusal(err);
        result.failures.push(`${label}: the reply was cut off and the rest could not be recovered (${describeError(err)})`);
      }
    }

    const shownPaths = new Set(initial ? initial.keys() : []);
    const newlyRequested = filesNeeded.filter((path) => !shownPaths.has(path));
    if (newlyRequested.length > 0 && !result.refusal) {
      try {
        const contents = await fetchAndBudgetContextFiles({
          requested: [...shownPaths, ...newlyRequested], cache: p.cache, service: p.service,
          project: p.target.project, repo: p.target.repo, commit: p.commit, tokenBudget: p.tokenBudget, budgetAgainst: part.items,
        });
        if ([...contents.keys()].some((path) => !shownPaths.has(path))) {
          for (const path of contents.keys()) if (!result.contextPaths.includes(path)) result.contextPaths.push(path);
          // The second call sees the first one's findings and refines them rather than replacing them.
          const second = parseReviewReply(await callWithRetry(
            ctx, p.buildPrompt(part.items, contents, { priorFindings: partFindings }), `${label} with whole files`, assertReadableReply,
            { site: { pass: 'pass2', batch, totalBatches, itemCount: part.items.length } },
          ));
          const resolved = resolveFindingAnchors(second.findings as Finding[], part.items, anchorOptions);
          const merged = mergePass2Findings(partFindings, resolved.findings, second.retract);
          rawCount += second.findings.length;
          droppedOutsidePr += resolved.droppedOutsidePr;
          retracted += merged.retracted;
          partFindings = merged.findings;
        }
      } catch (err) {
        if (isStop(err, ctx.signal)) throw err;
        noteRefusal(err);
        result.failures.push(`${label}: the call with whole files failed, so the first findings are kept (${describeError(err)})`);
      }
    }
    // Counted once per part, after the continuation and the call with whole files have settled.
    result.rawCount += rawCount;
    result.droppedOutsidePr += droppedOutsidePr;
    result.retracted += retracted;
    result.findings.push(...partFindings.map((f) => ({ ...f, sources: [p.source] })));
  }
  if (anyMeta) result.recommendedPersonas = [...recommended];
  return result;
}
