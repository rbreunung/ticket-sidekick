import type { BitbucketPR } from '../../bitbucket/IBitbucketClient';
import type { PrReviewService } from '../../services/PrReviewService';
import { withEasierRetry } from '../../utils/lmRetry';
import {
  mergePass2Findings,
  parseReviewReply,
  resolveFindingAnchors,
  type FileDiff,
  type ReviewFinding,
  type SourceTag,
} from '../reviewSessionState';
import {
  assertReadableReply,
  callOnce,
  callWithRetry,
  describeError,
  fetchAndBudgetContextFiles,
  isStop,
  rethrowStop,
  splitInHalf,
  type PassContext,
} from './plumbing';

// One batch of a review pass: the first call (split and retried as today), the continuation of a
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
  source: SourceTag;
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
}

/** Reviews one batch. A stop throws; every other failure is reported in the result. */
export async function reviewBatch(p: BatchReviewParams): Promise<BatchReviewResult> {
  const { ctx, files, label } = p;
  const initial = p.initialContext && p.initialContext.size > 0 ? p.initialContext : undefined;
  const parts = await withEasierRetry(
    files,
    async (items) => {
      const raw = await callOnce(ctx, p.buildPrompt(items, initial));
      assertReadableReply(raw);
      return raw;
    },
    splitInHalf,
    {
      ...(ctx.sleep ? { sleep: ctx.sleep } : {}),
      onAttemptFailed: (attempt, err, items) => {
        if (isStop(err, ctx.signal)) return;
        ctx.log('warn', `Model call failed — ${label} (attempt ${attempt})`, {
          files: items.map((f) => f.path), error: err instanceof Error ? err.message : String(err),
        });
      },
    },
  );
  rethrowStop(parts.map((part) => part.error), ctx.signal);

  const result: BatchReviewResult = { findings: [], contextPaths: initial ? [...initial.keys()] : [], reviewedFiles: 0, failedFiles: 0, failures: [] };
  let anyMeta = false;
  const recommended = new Set<string>();

  for (const part of parts) {
    if (part.error !== undefined) {
      result.failedFiles += part.items.length;
      result.failures.push(`${label}: could not review ${part.items.map((f) => f.path).join(', ')} (${describeError(part.error)})`);
      continue;
    }
    result.reviewedFiles += part.items.length;
    const reply = parseReviewReply(part.result!);
    if (reply.hasMetaLine) { anyMeta = true; reply.recommendedPersonas.forEach((id) => recommended.add(id)); }
    let partFindings = resolveFindingAnchors(reply.findings as Finding[], part.items).findings;
    let filesNeeded = reply.additionalFilesNeeded;

    if (reply.truncated) {
      try {
        const cont = parseReviewReply(await callWithRetry(
          ctx, p.buildPrompt(part.items, initial, { alreadyReported: partFindings }), `${label} continuation`, assertReadableReply,
        ));
        if (cont.hasMetaLine) { anyMeta = true; cont.recommendedPersonas.forEach((id) => recommended.add(id)); }
        filesNeeded = [...new Set([...filesNeeded, ...cont.additionalFilesNeeded])];
        partFindings = [...partFindings, ...resolveFindingAnchors(cont.findings as Finding[], part.items).findings];
      } catch (err) {
        if (isStop(err, ctx.signal)) throw err;
        result.failures.push(`${label}: the reply was cut off and the rest could not be recovered (${describeError(err)})`);
      }
    }

    const shownPaths = new Set(initial ? initial.keys() : []);
    const newlyRequested = filesNeeded.filter((path) => !shownPaths.has(path));
    if (newlyRequested.length > 0) {
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
          ));
          const resolved = resolveFindingAnchors(second.findings as Finding[], part.items).findings;
          partFindings = mergePass2Findings(partFindings, resolved, second.retract).findings;
        }
      } catch (err) {
        if (isStop(err, ctx.signal)) throw err;
        result.failures.push(`${label}: the call with whole files failed, so the first findings are kept (${describeError(err)})`);
      }
    }
    result.findings.push(...partFindings.map((f) => ({ ...f, sources: [p.source] })));
  }
  if (anyMeta) result.recommendedPersonas = [...recommended];
  return result;
}

