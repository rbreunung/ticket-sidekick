import type { ApplyLineResult, Conflict, DerivedPart, Session, WritePlan } from './sessionTypes';

// A board kind is the one place that knows a board's rules. `reduce`, `plan` and `reconcile` are
// pure, so a board's behaviour is tested as scenarios without a browser or a server. The session
// manager calls these members and knows nothing about Jira, Bitbucket or any board.
//
// R recipe, D derived data, W working state, A action, V the view the page gets, X dependencies.

export type Validated<R> = { ok: true; recipe: R } | { ok: false; reason: string };

export type Reduced<W> = { ok: true; working: W } | { ok: false; reason: string };

export type Planned = { ok: true; plan: WritePlan } | { ok: false; reason: string };

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

export interface BoardKind<R, D, W, A, V, X> {
  kind: string;
  /** Raise when the stored shape changes; sessions of another format are discarded. */
  formatVersion: number;
  title(recipe: R): string;
  /** Turns the open input into a recipe, or the reason the board cannot open. */
  validate(input: unknown, deps: X): Promise<Validated<R>>;
  /** The normalised source the session id is derived from. */
  sourceKey(recipe: R): string;
  /** A short description of the source for the sessions board. */
  sourceLabel(recipe: R): string;
  initialWorking(recipe: R): W;
  /** Reads the sources. Used to build a new session and to check a stored one. */
  read(recipe: R, deps: X): Promise<DerivedPart<D>>;
  /** Lays the stored working state over a fresh reading and names what no longer fits. */
  reconcile(session: Session<R, D, W>, fresh: DerivedPart<D>): Reconciled<D, W>;
  /** A non-writing action: select, filter, pick, resolve or drop a conflict. */
  reduce(session: Session<R, D, W>, action: A): Reduced<W>;
  /** The write plan for a writing action. Kinds without writes omit it. */
  plan?(session: Session<R, D, W>, action: A): Planned;
  /** Reads the targets again, writes the unchanged ones and reports each. */
  apply?(session: Session<R, D, W>, plan: WritePlan, deps: X): Promise<Applied<D, W>>;
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
