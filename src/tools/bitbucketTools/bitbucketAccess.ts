import { z } from 'zod';
import type { BitbucketConfig, IBitbucketClient } from '../../bitbucket/IBitbucketClient';
import type { ReviewDerived, ReviewWorking } from '../../boards/review/kind';
import type { ReviewRecipe } from '../../boards/review/recipe';
import type { Session } from '../../sessions/sessionTypes';
import type { DiagLogger } from '../../utils/diagTypes';
import type { UsageStore } from '../../utils/tokenUsage';
import { buildBitbucketNotConfiguredMessage } from '../../services/setupHints';
import { isSafePathSegment } from '../pathSafety';
import type { RecentCallGuard } from '../recentCallGuard';
import { ToolFailure, toolErrorLabel } from '../toolDefinition';

// What every Bitbucket tool handler receives. The extension builds one `BitbucketToolDeps` at
// activation; `getBitbucket()` reads the settings and credentials again at every tool call, so a
// token set or a setting changed later is seen without a restart. vscode-free.

export type BitbucketAccess =
  | { configured: true; config: BitbucketConfig; client: IBitbucketClient }
  | { configured: false; config: BitbucketConfig };

export type StoredReview = Session<ReviewRecipe, ReviewDerived, ReviewWorking>;

export interface BitbucketToolDeps {
  /** The current Bitbucket settings, plus a client when Bitbucket is configured. */
  getBitbucket(): Promise<BitbucketAccess>;
  /**
   * Remembers the comments posted in the last minute, so an identical call repeated shortly after
   * is skipped instead of posting twice. Created once at activation.
   */
  recentWrites: RecentCallGuard;
  /** Opens the review board of a pull request in an editor tab; absent where boards are not available. */
  openReview?(input: { url: string; ticketKey?: string; question?: string }): Promise<{ ok: true; title: string } | { ok: false; reason: string }>;
  /**
   * The stored review session with this id, as it is: no check starts and nothing is read from
   * Bitbucket. Undefined when none is stored.
   */
  storedReview(id: string): Promise<StoredReview | undefined>;
  /** The monthly per-model token counters of the reviews. */
  tokenUsage(): UsageStore;
  now(): Date;
  onDiag?: DiagLogger;
}

/** The pull request input of the tools that name one by project, repository and number. */
export const pullRequestShape = {
  project: z.string().describe('Bitbucket project key (Data Center) or workspace (Cloud), e.g. PROJ or myworkspace.'),
  repo: z.string().describe('Repository slug, e.g. myrepo.'),
  prId: z.number().int().positive().describe('Pull request id, e.g. 42.'),
};

/** Why a project or repository value cannot name a pull request, or undefined when both can. */
export function pullRequestProblem(project: string, repo: string): string | undefined {
  if (!project || !repo) return 'A project (or workspace) and a repo are required.';
  if (!isSafePathSegment(project) || !isSafePathSegment(repo)) return 'The project/workspace or repo value is not valid.';
  return undefined;
}

/**
 * Runs a tool's Bitbucket work. Without a configured Bitbucket the agent gets the setup hint and
 * no request is made. A failed request is logged and answered as `<failure>: <reason>`; a
 * `ToolFailure` the work throws is passed on as it is.
 */
export async function withBitbucket(
  deps: BitbucketToolDeps,
  tool: string,
  failure: string,
  work: (access: Extract<BitbucketAccess, { configured: true }>) => Promise<string>,
): Promise<string> {
  const access = await deps.getBitbucket();
  if (!access.configured) return buildBitbucketNotConfiguredMessage(access.config);
  try {
    return await work(access);
  } catch (err) {
    if (err instanceof ToolFailure) throw err;
    const message = err instanceof Error ? err.message : String(err);
    deps.onDiag?.('error', `${tool} failed`, { error: message });
    throw new ToolFailure(`${failure}: ${message}`, toolErrorLabel(err));
  }
}
