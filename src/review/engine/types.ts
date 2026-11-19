import type { BitbucketPR, IBitbucketClient } from '../../bitbucket/IBitbucketClient';
import type { BoardModelHandle } from '../../boards/boardModels';
import type { PersonaId } from '../../services/PrReviewService';
import type { RequirementsSourceResult } from '../../services/TicketService';
import type { DiagLogger } from '../../utils/diagTypes';
import type { TokenFigures } from '../../utils/tokenUsage';
import type { RequirementsCoverage } from '../requirementsCoverage';
import type { FileDiff, ReviewFinding } from '../reviewSessionState';

// The staged review's data and dependencies. Everything a review keeps is plain JSON, so a board can
// store it in its session as it is. vscode-free.

/** The pull request a review is about. */
export interface ReviewTarget {
  project: string;
  repo: string;
  prId: number;
}

/** One batch of the regular pass: the diff pieces it reviewed and the context files its passes read. */
export interface ReviewBatch {
  files: FileDiff[];
  /** Paths of the whole files the passes over this batch read, at the reviewed commit. */
  contextPaths: string[];
}

/**
 * What later passes work on. The batches together hold the full parsed diff the regular pass reviewed,
 * in its order; context files are kept by path only and read again at `reviewedCommit` when needed.
 */
export interface ReviewSnapshot {
  target: ReviewTarget;
  pr: BitbucketPR;
  /** The commit every file is read at, for as long as the review lives. */
  reviewedCommit: string;
  batches: ReviewBatch[];
}

/** The steps of a staged review: the regular pass, the four persona passes and the critic. */
export type ReviewStep = 'regular' | PersonaId | 'critic';

export interface StoredFinding extends ReviewFinding {
  /** Index of the batch the finding was first found in; the critic judges it with that batch's diff. */
  batch: number;
  /** The critic could not confirm it, but the developer had worked on it, so it was kept with this label. */
  probablyFalseAlarm?: true;
}

/** The numbered findings of one review. A number is given once and never reused or changed. */
export interface FindingStore {
  findings: StoredFinding[];
  nextNumber: number;
  /** Steps that ran over every batch. A stopped step is not listed. */
  stepsRun: ReviewStep[];
  /** Numbers of the findings the critic gave a verdict on. */
  criticChecked: number[];
}

/** Which extra passes the regular pass suggests. */
export type PassSuggestion =
  | { kind: 'suggested'; personas: PersonaId[] }
  /** The batches answered, and none asked for an extra pass. */
  | { kind: 'none-suggested' }
  /** No finished batch gave a readable recommendation. */
  | { kind: 'no-usable-recommendation' };

/** What the requirements check compares the diff with. */
export type RequirementsChoice =
  | { kind: 'none' }
  | { kind: 'ticket'; key: string }
  /** The developer's goal, as it stands when the check runs (possibly a reworded and corrected text). */
  | { kind: 'goal'; text: string };

/** One review as the board keeps it. */
export interface StagedReview {
  snapshot: ReviewSnapshot;
  store: FindingStore;
  suggestion: PassSuggestion;
  requirements: RequirementsChoice;
  coverage?: RequirementsCoverage;
}

export interface TokenTotals {
  input: number;
  output: number;
  calls: number;
  estimated: boolean;
}

/** How one pass ended. */
export type PassStatus =
  | 'finished'
  /** Stopped by the developer: the finished batches' work is kept. */
  | 'stopped'
  /** A context file could not be read at the reviewed commit, so nothing ran and nothing changed. */
  | 'commit-unreadable'
  /** No batch got a readable reply (regular pass), or the step could not run at all. */
  | 'failed'
  /** The diff had nothing to review after the filters. */
  | 'nothing-to-review';

export interface PassOutcome {
  step: ReviewStep;
  status: PassStatus;
  batchesDone: number;
  batchesTotal: number;
  /** Batches with a part that failed after the retries; their other parts' findings stand. */
  failedBatches: number;
  /** Short, plain notes on what failed or was skipped, for the board's banner. */
  notes: string[];
  /** Numbers given to new findings. */
  added: number[];
  /** Numbers of existing findings a duplicate was merged into. */
  merged: number[];
  /** Numbers the critic removed. */
  removed: number[];
  /** Numbers the critic labelled as probably a false alarm. */
  labelled: number[];
  tokens: TokenTotals;
  /** The path that could not be read, when the status is `commit-unreadable`. */
  unreadablePath?: string;
  /** The cause, when the status is `failed`. */
  error?: string;
}

export type RequirementsOutcome =
  | { status: 'not-run' }
  | { status: 'checked' }
  | { status: 'ticket-unreadable'; key: string; reason: 'not-found' | 'auth' | 'error'; message: string }
  | { status: 'failed' }
  | { status: 'stopped' };

/** The review settings the passes read. */
export interface EngineSettings {
  /** The developer's own review instructions; joined with `focus` and given to every review prompt. */
  reviewInstructions?: string;
  /** A focus question for this review. */
  focus?: string;
  contextLines?: number;
  excludePatterns?: string[];
  /** The model's context size when set; else the model's own, else 60000. */
  modelContextTokens?: number;
  /** Share of the context a call may fill; default 0.7. */
  contextBudgetRatio?: number;
}

export interface EngineProgress {
  step: ReviewStep | 'requirements';
  batchesDone: number;
  batchesTotal: number;
  /**
   * The review as it stands after the batch just finished, with the step not marked as run: what a
   * stop at this point would hand over. Set on the per-batch reports of the regular pass, the persona
   * passes and the critic, so a board can save it and keep the finished batches after a restart.
   */
  review?: StagedReview;
}

export interface EngineDeps {
  /** The review model. The engine meters every call through it. */
  model: BoardModelHandle;
  /** Records one call's token figures; the board keeps the monthly counters. */
  recordTokens: (modelId: string, figures: TokenFigures) => PromiseLike<void>;
  client: IBitbucketClient;
  /** Reads a Jira ticket's requirements text; needed only for a ticket choice. */
  readTicket?: (key: string) => Promise<RequirementsSourceResult>;
  /** Aborting it stops the pass at once. */
  signal: AbortSignal;
  onProgress?: (progress: EngineProgress) => void;
  onDiag?: DiagLogger;
  /** Waits between retries; tests pass one that does not wait. */
  sleep?: (ms: number) => Promise<void>;
}
