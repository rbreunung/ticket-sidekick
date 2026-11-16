import type { ApplyLineResult, Conflict, DerivedPart, Session, WritePlan } from './sessionTypes';

// A board kind is the one place that knows a board's rules. `reduce`, `plan` and `reconcile` are
// pure, so a board's behaviour is tested as scenarios without a browser or a server. The session
// manager calls these members and knows nothing about Jira, Bitbucket or any board.
//
// R recipe, D derived data, W working state, A action, V the view the page gets, X dependencies.

export type Validated<R> = { ok: true; recipe: R } | { ok: false; reason: string };

export type Reduced<W> = { ok: true; working: W } | { ok: false; reason: string };

export type Planned = { ok: true; plan: WritePlan } | { ok: false; reason: string };

/** Why the sources are read again: by itself when a stored board is shown, or on the developer's Refresh. */
export type CheckMode = 'background' | 'refresh';

export interface Reconciled<D, W> {
  derived: DerivedPart<D>;
  working: W;
  conflicts: Conflict[];
}

export interface Applied<D, W> {
  results: ApplyLineResult[];
  derived: DerivedPart<D>;
  working: W;
  /** Targets that changed since the board read them become conflicts. */
  conflicts?: Conflict[];
}

/** What `apply` reports after each finished target: the working state that records what is done so far. */
export interface ApplyProgressReport<W> {
  working: W;
  done: number;
  total: number;
}

/**
 * Saves the reported working state and tells the page. A kind awaits it before its next write, so a
 * board restored after an interrupted Apply shows the finished targets as done.
 */
export type ApplyProgress<W> = (report: ApplyProgressReport<W>) => Promise<void>;

export interface ExportedFile {
  fileName: string;
  /** The name and extension VS Code's save dialog filters by. */
  filterName: string;
  extension: string;
  bytes: Uint8Array;
}

export interface BoardKind<R, D, W, A, V, X> {
  kind: string;
  /** Raise when the stored shape changes; a session of another format is rebuilt from its recipe (see `revalidate`) or discarded. */
  formatVersion: number;
  title(recipe: R): string;
  /** Turns the open input into a recipe, or the reason the board cannot open. */
  validate(input: unknown, deps: X): Promise<Validated<R>>;
  /**
   * Checks that the recipe of a stored session of another format still holds, so the board can be
   * rebuilt from it after an update. It reads neither an open request nor the settings that choose
   * a source. A kind without it, or a recipe that fails, leaves the session discarded.
   */
  revalidate?(recipe: unknown, deps: X): Promise<Validated<R>>;
  /** The normalised source the session id is derived from. */
  sourceKey(recipe: R): string;
  /** A short description of the source for the sessions board. */
  sourceLabel(recipe: R): string;
  initialWorking(recipe: R): W;
  /** The working state when the board is asked for again with a new request, e.g. another proposed change. */
  reopen?(session: Session<R, D, W>, recipe: R): W;
  /** Reads the sources. Used to build a new session and to check a stored one. */
  read(recipe: R, deps: X): Promise<DerivedPart<D>>;
  /**
   * Lays the stored working state over a fresh reading and names what no longer fits. A board may
   * keep showing what the developer saw after a background check and take the fresh reading only on Refresh.
   */
  reconcile(session: Session<R, D, W>, fresh: DerivedPart<D>, mode: CheckMode): Reconciled<D, W>;
  /** A non-writing action: select, filter, pick, resolve or drop a conflict. */
  reduce(session: Session<R, D, W>, action: A): Reduced<W>;
  /**
   * What a writing action needs to read before its plan can be shown, such as the target ticket of
   * an add; its result is passed to `plan`. Kinds whose plans read nothing omit it.
   */
  prepare?(session: Session<R, D, W>, action: A, deps: X): Promise<unknown>;
  /** The write plan for a writing action, given what `prepare` read. Kinds without writes omit it. */
  plan?(session: Session<R, D, W>, action: A, prepared?: unknown): Planned;
  /** Reads the targets again, writes the unchanged ones and reports each, through `progress` as each finishes. */
  apply?(session: Session<R, D, W>, plan: WritePlan, deps: X, progress?: ApplyProgress<W>): Promise<Applied<D, W>>;
  /** A file the developer saves from the board, always built from the reading the board shows. */
  exportFile?(session: Session<R, D, W>, format: string, deps: X): Promise<ExportedFile>;
  /** What the page gets: never more than it shows. */
  view(session: Session<R, D, W>): V;
}

/** A kind as the session manager holds it, with its types erased and its dependencies resolved per call. */
export interface RegisteredKind {
  kind: BoardKind<unknown, unknown, unknown, unknown, unknown, unknown>;
  deps(): unknown | Promise<unknown>;
}

export function registerKind<R, D, W, A, V, X>(kind: BoardKind<R, D, W, A, V, X>, deps: () => X | Promise<X>): RegisteredKind {
  return { kind: kind as unknown as RegisteredKind['kind'], deps };
}
