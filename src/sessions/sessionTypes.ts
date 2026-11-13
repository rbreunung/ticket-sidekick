// The session model behind every board (docs/architecture/boards-and-sessions.md). The extension
// owns one session per source; a board page only shows it. A session keeps three parts apart
// because they have different truths: the recipe (what was asked for), the data derived from Jira,
// Bitbucket, a report file or a model run, and the developer's working state, which exists nowhere
// else. No `vscode` import anywhere under src/sessions.

/** Where derived data came from and when, so a later check can tell whether the source moved. */
export interface DerivedPart<D> {
  /** Epoch milliseconds of the reading the board shows ("as of"). */
  readAt: number;
  /** One entry per source, e.g. a report file's hash or a PR's head commit. */
  fingerprints: Record<string, string>;
  data: D;
}

/** Working state whose target changed or disappeared in a fresh reading. */
export interface Conflict {
  id: string;
  /** What the conflict is about, e.g. a ticket key. Shown to the developer. */
  target: string;
  message: string;
  /** The value the stored session held and the one read now, when showing both helps. */
  stored?: string;
  fresh?: string;
}

export interface Session<R = unknown, D = unknown, W = unknown> {
  id: string;
  kind: string;
  /** The board kind's format when this session was written; another format is discarded, never migrated. */
  formatVersion: number;
  /** Raised by every change; an action based on an older revision is refused. */
  revision: number;
  createdAt: number;
  lastUsedAt: number;
  recipe: R;
  derived: DerivedPart<D>;
  working: W;
  conflicts: Conflict[];
}

/** One line of a write plan: the target and exactly what is written to it. */
export interface PlanLine {
  target: string;
  change: string;
}

/** What a writing action will do, shown as the preview before Apply. */
export interface WritePlan<P = unknown> {
  title: string;
  lines: PlanLine[];
  /** More than one ticket, a close, or a Bitbucket post: needs the native confirmation as well. */
  risky: boolean;
  /** What `apply` needs; never sent to the page. */
  payload: P;
}

export interface ApplyLineResult {
  target: string;
  outcome: 'done' | 'failed' | 'refused';
  /** Why a target failed or was refused (it changed since the board read it). */
  reason?: string;
}

/** What the sessions board shows for one stored session. */
export interface SessionSummary {
  id: string;
  kind: string;
  title: string;
  source: string;
  createdAt: number;
  lastUsedAt: number;
  readAt: number;
  bytes: number;
}

/** A request the session layer refuses, with the HTTP status the board route answers. */
export class SessionError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}
