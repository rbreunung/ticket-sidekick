import type * as vscode from 'vscode';
import { BitbucketApiClient } from '../bitbucket/BitbucketApiClient';
import type { RegisteredBoards } from '../boards/registerBoards';
import type { ReviewDerived, ReviewWorking } from '../boards/review/kind';
import { REVIEW_KIND, type ReviewRecipe } from '../boards/review/recipe';
import type { ConfigService } from '../services/ConfigService';
import type { Session } from '../sessions/sessionTypes';
import { logDiag } from '../utils/diagLog';
import { TokenUsageService } from '../utils/tokenUsage';
import type { BitbucketAccess, BitbucketToolDeps } from './bitbucketTools/bitbucketAccess';
import { BITBUCKET_TOOLS } from './bitbucketTools/catalog';
import { RecentCallGuard } from './recentCallGuard';
import { registerCatalog } from './registerCatalog';

// Registers the Bitbucket tool catalog with VS Code as language model tools. Bitbucket
// configuration is no start condition; the tools read it at every call and answer with the setup
// hint while it is missing. The review tools open and read the review board's sessions.

async function getBitbucket(configService: ConfigService): Promise<BitbucketAccess> {
  const config = await configService.getBitbucketConfig();
  if (!configService.isBitbucketConfigured(config)) return { configured: false, config };
  // Cloud ignores the base URL and talks to api.bitbucket.org; Data Center uses it.
  const client = new BitbucketApiClient({
    baseUrl: config.baseUrl ?? '',
    authType: config.authType,
    token: config.token!,
    onDiag: (level, message, details) => logDiag('bitbucket.apiClient', level, message, details),
  });
  return { configured: true, config, client };
}

export function registerBitbucketTools(context: vscode.ExtensionContext, configService: ConfigService, boards: RegisteredBoards): void {
  // Reads the same monthly counters the review board writes; it never writes them.
  const usage = new TokenUsageService(context.globalState);
  const deps: BitbucketToolDeps = {
    getBitbucket: () => getBitbucket(configService),
    recentWrites: new RecentCallGuard(),
    openReview: input => boards.panels.open(REVIEW_KIND, input),
    // A look at the stored session only: no background check starts and Bitbucket is not asked.
    storedReview: async id => (await boards.manager.peek(REVIEW_KIND, id)) as Session<ReviewRecipe, ReviewDerived, ReviewWorking> | undefined,
    tokenUsage: () => usage.snapshot(),
    now: () => new Date(),
    onDiag: (level, message, details) => logDiag('tools.bitbucket', level, message, details),
  };
  registerCatalog(context, BITBUCKET_TOOLS, deps, 'tools.bitbucket');
}
