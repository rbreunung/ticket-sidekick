import * as vscode from 'vscode';
import { BitbucketApiClient } from '../bitbucket/BitbucketApiClient';
import type { BitbucketConfig } from '../bitbucket/IBitbucketClient';
import { ConfigService } from '../services/ConfigService';
import { PrReviewService } from '../services/PrReviewService';
import { logDiag } from '../utils/diagLog';
import { isSafePathSegment } from './pathSafety';
import { RecentCallGuard, fingerprint } from './recentCallGuard';
import {
  buildBitbucketNotConfiguredMessage,
  buildPostCommentConfirmation,
  formatPullRequestSummary,
  type ReviewFinding,
} from '../participant/reviewSessionState';

// ---------------------------------------------------------------------------------------------
// Language Model tools (Agent Mode) for @bitbucket, registered via `vscode.lm.registerTool` in
// `registerBitbucketTools()` below and declared in package.json's `contributes.languageModelTools`.
//
// Every tool here is thin glue: it resolves live data through the same three-layer stack the
// `@bitbucket` chat participant uses (PrReviewService → IBitbucketClient → BitbucketApiClient,
// or IBitbucketClient directly for a plain read) and hands the result to the pure formatters in
// `reviewSessionState.ts` (R3 — no separate, divergent implementation of the same operation).
// This file (importing `vscode`) is covered only by `npm run compile` and a manual Extension
// Development Host check (see CLAUDE.md's Testing section) — the pure formatters it calls into
// are covered by `src/test/bitbucketTools.test.ts`.
//
// KTD1: `invoke()` — not `prepareInvocation()`'s confirmation — is the write tool's real safety
// boundary, since `chat.tools.autoApprove` can bypass the confirmation dialog entirely. The
// write tool's `invoke()` re-validates its own inputs (non-empty project/repo, a positive PR
// id, non-empty comment text) independently of whatever `prepareInvocation` showed.
// `confirmationMessages` is always populated for it — never omitted.
//
// KTD5: the write tool's `invoke()` constructs `PrReviewService` with the same `onDiag` binding
// `BitbucketParticipant.ts` already uses, so tool-invoked writes are logged to the "Ticket
// Sidekick" output channel the same way chat-invoked comment posts are.
//
// KTD6: tools carry no session memory — every call takes fully-specified parameters (project,
// repo, PR id, …). No last-PR or in-progress-review context, unlike the chat participant.
//
// KTD8: Now-scoped to single-object read (bitbucket_getPullRequest, bitbucket_getPullRequestDiff)
// and write (bitbucket_postComment) only. There is no `bitbucket_reviewPr` tool — the full
// multi-pass review pipeline (chunking, anchor verification, critic pass) lives inline in
// `BitbucketParticipant.ts`, not as a callable `PrReviewService` method, and building a tool
// around it is explicitly deferred to a future plan (see docs/onboarding.md).
// ---------------------------------------------------------------------------------------------

function textResult(text: string): vscode.LanguageModelToolResult {
  return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
}

interface ConfiguredContext {
  config: BitbucketConfig;
  bitbucketClient: BitbucketApiClient;
  prReviewService: PrReviewService;
}

/**
 * Resolves the live Bitbucket connection every tool needs, reading config fresh on every call —
 * mirroring `BitbucketParticipant.ts`'s own per-request construction — rather than caching one
 * long-lived client/service pair, since credentials can be set or changed between tool calls
 * within the same VS Code session. Returns a `LanguageModelToolResult` carrying U1's
 * `buildBitbucketNotConfiguredMessage(config)` text (R4) when credentials aren't configured.
 */
async function tryGetConfiguredContext(configService: ConfigService): Promise<ConfiguredContext | vscode.LanguageModelToolResult> {
  const config = await configService.getBitbucketConfig();
  if (!configService.isBitbucketConfigured(config)) {
    return textResult(buildBitbucketNotConfiguredMessage(config));
  }
  // Mirrors BitbucketParticipant.ts's own construction: Cloud ignores baseUrl and talks to the
  // fixed api.bitbucket.org host baked into BitbucketApiClient; Data Center uses config.baseUrl.
  const bitbucketClient = new BitbucketApiClient({
    baseUrl: config.baseUrl ?? '',
    authType: config.authType,
    token: config.token!,
    onDiag: (level, message, details) => logDiag('bitbucket.apiClient', level, message, details),
  });
  const prReviewService = new PrReviewService(
    bitbucketClient,
    (level, message, details) => logDiag('bitbucket.prReviewService', level, message, details),
  );
  return { config, bitbucketClient, prReviewService };
}

function isNotConfiguredResult(value: ConfiguredContext | vscode.LanguageModelToolResult): value is vscode.LanguageModelToolResult {
  return value instanceof vscode.LanguageModelToolResult;
}

// -------------------------------------------------------------------------------------------
// Read tools
// -------------------------------------------------------------------------------------------

interface GetPullRequestInput {
  project: string;
  repo: string;
  prId: number;
}

class GetPullRequestTool implements vscode.LanguageModelTool<GetPullRequestInput> {
  constructor(private readonly configService: ConfigService) {}

  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<GetPullRequestInput>,
  ): Promise<vscode.PreparedToolInvocation> {
    const { project, repo, prId } = options.input;
    return { invocationMessage: `Fetching PR #${prId} (${project}/${repo})…` };
  }

  async invoke(options: vscode.LanguageModelToolInvocationOptions<GetPullRequestInput>): Promise<vscode.LanguageModelToolResult> {
    const project = options.input.project?.trim();
    const repo = options.input.repo?.trim();
    const prId = options.input.prId;
    if (!project || !repo) return textResult('A project (or workspace) and a repo are required.');
    if (!isSafePathSegment(project) || !isSafePathSegment(repo)) return textResult('The project/workspace or repo value is not valid.');
    if (!Number.isInteger(prId) || prId <= 0) return textResult('A positive pull request id is required, e.g. 42.');

    const ctx = await tryGetConfiguredContext(this.configService);
    if (isNotConfiguredResult(ctx)) return ctx;
    const { bitbucketClient } = ctx;

    try {
      const pr = await bitbucketClient.getPullRequest(project, repo, prId);
      return textResult(formatPullRequestSummary(pr));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logDiag('bitbucket.tools', 'error', `bitbucket_getPullRequest failed — ${project}/${repo}#${prId}`, { project, repo, prId, error: message });
      return textResult(`Could not fetch PR #${prId} (${project}/${repo}): ${message}`);
    }
  }
}

interface GetPullRequestDiffInput {
  project: string;
  repo: string;
  prId: number;
  contextLines?: number;
}

class GetPullRequestDiffTool implements vscode.LanguageModelTool<GetPullRequestDiffInput> {
  constructor(private readonly configService: ConfigService) {}

  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<GetPullRequestDiffInput>,
  ): Promise<vscode.PreparedToolInvocation> {
    const { project, repo, prId } = options.input;
    return { invocationMessage: `Fetching diff for PR #${prId} (${project}/${repo})…` };
  }

  async invoke(options: vscode.LanguageModelToolInvocationOptions<GetPullRequestDiffInput>): Promise<vscode.LanguageModelToolResult> {
    const project = options.input.project?.trim();
    const repo = options.input.repo?.trim();
    const prId = options.input.prId;
    if (!project || !repo) return textResult('A project (or workspace) and a repo are required.');
    if (!isSafePathSegment(project) || !isSafePathSegment(repo)) return textResult('The project/workspace or repo value is not valid.');
    if (!Number.isInteger(prId) || prId <= 0) return textResult('A positive pull request id is required, e.g. 42.');

    const ctx = await tryGetConfiguredContext(this.configService);
    if (isNotConfiguredResult(ctx)) return ctx;
    const { config, bitbucketClient } = ctx;
    // Falls back to the configured reviewContextLines (matching BitbucketParticipant.ts's own
    // review flow) when the caller omits contextLines — otherwise BitbucketApiClient silently
    // drops to Bitbucket's own server-side default instead of the value this tool's own
    // modelDescription promises.
    const contextLines = options.input.contextLines ?? config.reviewContextLines;

    try {
      const diff = await bitbucketClient.getPullRequestDiff(project, repo, prId, contextLines);
      if (!diff.trim()) return textResult(`PR #${prId} (${project}/${repo}) has no textual diff.`);
      return textResult(`## Diff for PR #${prId} (${project}/${repo})\n\n${diff}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logDiag('bitbucket.tools', 'error', `bitbucket_getPullRequestDiff failed — ${project}/${repo}#${prId}`, { project, repo, prId, error: message });
      return textResult(`Could not fetch the diff for PR #${prId} (${project}/${repo}): ${message}`);
    }
  }
}

// -------------------------------------------------------------------------------------------
// Write tool — shows an explicit confirmation naming the concrete change (R2), and re-validates
// its own inputs in invoke() regardless of what prepareInvocation() showed (KTD1).
// -------------------------------------------------------------------------------------------

interface PostCommentInput {
  project: string;
  repo: string;
  prId: number;
  comment: string;
}

class PostCommentTool implements vscode.LanguageModelTool<PostCommentInput> {
  // Each call posts a new comment (not idempotent) — a retried Agent Mode call with identical
  // input would otherwise post the same comment twice with no reconciliation.
  private readonly recentCalls = new RecentCallGuard();

  constructor(private readonly configService: ConfigService) {}

  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<PostCommentInput>,
  ): Promise<vscode.PreparedToolInvocation> {
    const { project, repo, prId, comment } = options.input;
    const confirmation = buildPostCommentConfirmation(
      project || '(unknown project)', repo || '(unknown repo)', prId ?? 0, comment || '(no comment text given)',
    );
    return {
      invocationMessage: `Posting a comment on PR #${prId} (${project}/${repo})…`,
      confirmationMessages: confirmation,
    };
  }

  async invoke(options: vscode.LanguageModelToolInvocationOptions<PostCommentInput>): Promise<vscode.LanguageModelToolResult> {
    const project = options.input.project?.trim();
    const repo = options.input.repo?.trim();
    const prId = options.input.prId;
    const comment = options.input.comment?.trim();
    if (!project || !repo) return textResult('A project (or workspace) and a repo are required.');
    if (!isSafePathSegment(project) || !isSafePathSegment(repo)) return textResult('The project/workspace or repo value is not valid.');
    if (!Number.isInteger(prId) || prId <= 0) return textResult('A positive pull request id is required, e.g. 42.');
    if (!comment) return textResult('Comment text is required.');
    const dupeKey = fingerprint(project, repo, prId, comment);
    if (!this.recentCalls.claim(dupeKey)) {
      return textResult(`Skipped: an identical comment on PR #${prId} (${project}/${repo}) was just posted in the last minute. If this is intentional, change the text or wait before retrying.`);
    }
    const release = () => this.recentCalls.release(dupeKey);

    const ctx = await tryGetConfiguredContext(this.configService);
    if (isNotConfiguredResult(ctx)) { release(); return ctx; } // not a real attempt — don't block a real retry
    const { prReviewService } = ctx;

    // A synthetic, line-less finding — postCommentItems only reads `line`/`lineType`/`fileType`
    // off it to decide whether to anchor the comment inline; leaving them undefined posts a
    // plain activity-feed comment, which is what this tool is for (no line-anchoring input).
    const finding: ReviewFinding = {
      id: 1,
      file: '',
      severity: 'suggestion',
      title: 'Comment',
      description: '',
      recommendation: '',
    };

    try {
      // Reuses PrReviewService.postCommentItems exactly as BitbucketParticipant.ts's
      // postAndReport/add-to-review paths do — the same per-item error handling and diag
      // logging, no divergent copy (R3).
      const [result] = await prReviewService.postCommentItems(project, repo, prId, [{ finding, text: comment }]);
      if (result.result) {
        const ref = result.result.commentUrl
          ? `[comment #${result.result.commentId}](${result.result.commentUrl})`
          : `comment #${result.result.commentId}`;
        return textResult(`Posted ${ref} on PR #${prId} (${project}/${repo}).`);
      }
      release(); // the comment wasn't actually posted — a retry isn't a duplicate
      return textResult(`Could not post comment on PR #${prId} (${project}/${repo}): ${result.error}`);
    } catch (err) {
      release(); // the comment wasn't actually posted — a retry isn't a duplicate
      const message = err instanceof Error ? err.message : String(err);
      logDiag('bitbucket.tools', 'error', `bitbucket_postComment failed — ${project}/${repo}#${prId}`, { project, repo, prId, error: message });
      return textResult(`Could not post comment on PR #${prId} (${project}/${repo}): ${message}`);
    }
  }
}

/** Registers every `bitbucket_*` Language Model tool with VS Code (matching the `name`s declared
 * under `contributes.languageModelTools` in package.json) and ties their disposal to the
 * extension's lifecycle via `context.subscriptions`. Called once from `activate()` in
 * `extension.ts`. */
export function registerBitbucketTools(context: vscode.ExtensionContext, configService: ConfigService): void {
  context.subscriptions.push(
    vscode.lm.registerTool('bitbucket_getPullRequest', new GetPullRequestTool(configService)),
    vscode.lm.registerTool('bitbucket_getPullRequestDiff', new GetPullRequestDiffTool(configService)),
    vscode.lm.registerTool('bitbucket_postComment', new PostCommentTool(configService)),
  );
}
