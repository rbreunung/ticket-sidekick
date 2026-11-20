import type { IBitbucketClient } from '../../bitbucket/IBitbucketClient';
import type { EngineSettings } from '../../review/engine';
import type { RequirementsSourceResult } from '../../services/TicketService';
import type { DiagLogger } from '../../utils/diagTypes';
import type { TokenFigures } from '../../utils/tokenUsage';
import type { BoardModels, ModelSettings } from '../boardModels';

// What the pull request review board needs from the extension. Everything is a function read at the
// moment it is needed, so a token or a setting changed while the board is open is seen. The VS Code
// bindings are in registerBoards.ts. vscode-free.

export type ReviewBitbucketAccess = { configured: true; client: IBitbucketClient } | { configured: false; hint: string };

/** The confidence below which a finding is marked as low confidence, when no setting gives one. */
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.7;

/** The review settings, plus the confidence below which a finding is marked as low confidence. */
export type ReviewSettings = Omit<EngineSettings, 'focus'> & { confidenceThreshold: number };

export interface ReviewBoardDeps {
  bitbucket(): Promise<ReviewBitbucketAccess>;
  /** Reads a ticket's requirements text; undefined while Jira is not configured. */
  jira(): Promise<{ readRequirements(key: string): Promise<RequirementsSourceResult> } | undefined>;
  models: Pick<BoardModels, 'list' | 'handle'>;
  modelSettings: Pick<ModelSettings, 'reviewModel' | 'writeReviewModel'>;
  settings(): Promise<ReviewSettings>;
  /** Adds one model call to the monthly per-model token counters. */
  recordTokens(modelId: string, figures: TokenFigures): PromiseLike<void>;
  /** The native confirmation; resolves false when the developer declines. */
  confirm(question: { title: string; detail: string; button: string }): Promise<boolean>;
  /** Called after a regular pass that went over every batch, for the walkthrough's "first review" step. */
  onReviewCompleted?(): void | PromiseLike<void>;
  now(): number;
  onDiag?: DiagLogger;
  /** The review passes' diagnostic timeline: the configuration, every model call, retries, the findings funnel. */
  reviewDiag?: DiagLogger;
  /** Waits between retries; tests pass one that does not wait. */
  sleep?(ms: number): Promise<void>;
}

/** The plain-text hint the board shows while Bitbucket is not configured. */
export const BITBUCKET_NOT_CONFIGURED = 'Bitbucket is not configured. Run "Ticket Sidekick: Set Bitbucket Personal Access Token" (Data Center, with ticketSidekick.bitbucket.baseUrl set) or "Ticket Sidekick: Configure Bitbucket Cloud Credentials" (Cloud) from the Command Palette.';
