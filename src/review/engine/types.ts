import type { BitbucketPR, IBitbucketClient } from '../../bitbucket/IBitbucketClient';
import type { BoardModelHandle } from '../../boards/boardModels';
import type { PersonaId } from '../../services/PrReviewService';
import type { DiagLogger } from '../../utils/diagTypes';
import type { TokenFigures } from '../../utils/tokenUsage';
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

/** One review as the board keeps it. */
export interface StagedReview {
  snapshot: ReviewSnapshot;
  store: FindingStore;
  suggestion: PassSuggestion;
}

export interface TokenTotals {
  input: number;
  output: number;
  calls: number;
  estimated: boolean;
}

/** Two token totals added up; no first total gives the second. */
export function addTokenTotals(a: TokenTotals | undefined, b: TokenTotals): TokenTotals {
  if (!a) return b;
  return { input: a.input + b.input, output: a.output + b.output, calls: a.calls + b.calls, estimated: a.estimated || b.estimated };
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
  /** Findings left out because they named a file outside the pull request. */
  droppedOutsidePr?: number;
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
  /** Also write each pass's structured run record (configuration, every call and event line, the findings funnel). */
  detailedDiagnostics?: boolean;
}

export interface EngineProgress {
  step: ReviewStep;
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
  /** Aborting it stops the pass at once. */
  signal: AbortSignal;
  onProgress?: (progress: EngineProgress) => void;
  onDiag?: DiagLogger;
  /** Waits between retries; tests pass one that does not wait. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Files read at a commit during one run of several passes, by commit and path, so a later pass of
   * the run does not read them again. Lives for the run only; nothing of it is stored.
   */
  runCache?: Map<string, string>;
}
