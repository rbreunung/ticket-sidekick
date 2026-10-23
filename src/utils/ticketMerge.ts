// Waltz ticket merge: pure helpers (vscode-free) — the text a cancelled ticket is marked with, the reference
// resolution, the step plan and the rule that decides between refreshing the review and marking it out of date.
import { BATCH_LIMIT, MAX_SUMMARY_CHARS, clampSummary } from './reportImport';
import { isTicketedRowFinished, ticketedTargetKey, type MergeStep, type ReviewRowBase, type SourceMove } from '../participant/session/importTypes';

const MERGED_PREFIX = /^\[Merged into [A-Z][A-Z0-9]+-\d+\] /;
const BANNER = /^\{panel:title=Merged into [A-Z][A-Z0-9]+-\d+\}[\s\S]*?\{panel\}\n*/;

/** `[Merged into KEY] <old summary>`, within the 255-character limit by trimming only the old summary; an earlier marker is replaced. */
export function mergedSummary(summary: string, survivorKey: string): string {
  const prefix = `[Merged into ${survivorKey}] `;
  const base = summary.replace(MERGED_PREFIX, '');
  return prefix + clampSummary(base, '', MAX_SUMMARY_CHARS - prefix.length);
}

/** The banner (Jira wiki) above the body of a cancelled ticket; the body stays as it was, and an earlier banner is replaced. */
export function mergedBanner(description: string | null | undefined, survivorKey: string): string {
  const banner = `{panel:title=Merged into ${survivorKey}}\nThis ticket was merged into ${survivorKey} and closed as a duplicate. Its items are tracked there.\n{panel}`;
  const body = (description ?? '').replace(BANNER, '');
  return body === '' ? banner : `${banner}\n\n${body}`;
}

const ROW_ID = /^A\d+$/i;
const TICKET_KEY = /^[A-Z][A-Z0-9]+-\d+$/i;

/** The two sides of a `merge … into …` reply, resolved to ticket keys, or the reason nothing is written (R4). */
export type MergeSides = { ok: true; survivor: string; sources: string[] } | { ok: false; reason: string };

/**
 * KTD2: resolves the sides of a merge against the review's rows. An `A` id (finished rows included) becomes the
 * ticket its row points to; a Jira key is taken as typed, upper-cased. The reply is refused when the same ticket
 * is on both sides, a side is neither an id nor a key, more than `BATCH_LIMIT` sources are named, or no report row
 * points to the survivor or to any source (the rewrite would have nothing to rebuild from).
 */
export function resolveMergeSides(rows: ReviewRowBase[], sourceRefs: string[], survivorRef: string): MergeSides {
  const resolve = (ref: string): string | { error: string } => {
    if (ROW_ID.test(ref)) {
      const row = rows.find(r => r.existingTicketKey !== null && r.id.toLowerCase() === ref.toLowerCase());
      return row ? ticketedTargetKey(row) : { error: `${ref} is not an Already-ticketed row.` };
    }
    if (TICKET_KEY.test(ref)) return ref.toUpperCase();
    return { error: `${ref} is neither an Already-ticketed row id (like A3) nor a ticket key (like PROJ-12).` };
  };

  const survivor = resolve(survivorRef);
  if (typeof survivor !== 'string') return { ok: false, reason: survivor.error };
  const sources: string[] = [];
  for (const ref of sourceRefs) {
    const key = resolve(ref);
    if (typeof key !== 'string') return { ok: false, reason: key.error };
    if (key === survivor) return { ok: false, reason: `${key} is on both sides of the merge.` };
    if (!sources.includes(key)) sources.push(key);
  }
  if (sources.length === 0) return { ok: false, reason: 'Name at least one ticket to merge.' };
  if (sources.length > BATCH_LIMIT) return { ok: false, reason: `At most ${BATCH_LIMIT} tickets can be merged in one reply; you named ${sources.length}.` };
  const named = new Set([survivor, ...sources]);
  if (!rows.some(r => r.existingTicketKey !== null && named.has(ticketedTargetKey(r)))) {
    return { ok: false, reason: 'No row of this report points to those tickets, so there is nothing to rebuild them from.' };
  }
  return { ok: true, survivor, sources };
}

/** R8: the survivor's rewrite and comment first, then each source's link and rewrite, and every close last. */
export function buildMergePlan(survivor: string, sources: string[]): MergeStep[] {
  const step = (kind: MergeStep['kind'], key: string): MergeStep => ({ kind, key, status: 'pending' });
  return [
    step('survivor-rewrite', survivor),
    step('survivor-comment', survivor),
    ...sources.flatMap(key => [step('link', key), step('source-rewrite', key)]),
    ...sources.map(key => step('close', key)),
  ];
}

/**
 * Close mode (KTD2): for each source, the items only it records (its dedup keys minus the kept ticket's). An item the
 * rebuilt kept ticket still covers is `movable`; one the report no longer lists (`droppedKeys`, from the rewrite plan)
 * is `unlisted` and is named in the comment on the closed source instead of moved. Pure.
 */
export function analyzeSourceMoves(params: {
  survivorLabels: string[];
  sources: Array<{ key: string; labels: string[] }>;
  labelToKey: (label: string) => string | null;
  droppedKeys: string[];
}): SourceMove[] {
  const keysOf = (labels: string[]) => [...new Set(labels.map(params.labelToKey).filter((k): k is string => k !== null))];
  const onSurvivor = new Set(keysOf(params.survivorLabels));
  const dropped = new Set(params.droppedKeys);
  return params.sources.map(source => {
    const only = keysOf(source.labels).filter(k => !onSurvivor.has(k));
    return { key: source.key, movable: only.filter(k => !dropped.has(k)), unlisted: only.filter(k => dropped.has(k)) };
  });
}

/** Close mode (KTD3): `Relates` when items moved from the source, `Duplicate` when none did; the other one when the project lacks the wanted type. */
export function closeLinkType(itemsMoved: boolean, linkTypeNames: string[]): 'Relates' | 'Duplicate' {
  const wanted = itemsMoved ? 'Relates' : 'Duplicate';
  const other = itemsMoved ? 'Duplicate' : 'Relates';
  const has = (name: string) => linkTypeNames.some(n => n.toLowerCase() === name.toLowerCase());
  return has(wanted) || !has(other) ? wanted : other;
}

/**
 * Close mode (KTD3): the kept ticket is rewritten first, only when some source has items to move; then each source is
 * linked (its link type fixed here from whether items moved) and commented on; every close comes last.
 */
export function buildCloseMergePlan(survivor: string, moves: SourceMove[], linkTypeNames: string[]): MergeStep[] {
  const step = (kind: MergeStep['kind'], key: string, linkType?: string): MergeStep => ({ kind, key, status: 'pending', ...(linkType ? { linkType } : {}) });
  return [
    ...(moves.some(m => m.movable.length > 0) ? [step('survivor-rewrite', survivor)] : []),
    ...moves.flatMap(m => [step('link', m.key, closeLinkType(m.movable.length > 0, linkTypeNames)), step('source-comment', m.key)]),
    ...moves.map(m => step('close', m.key)),
  ];
}

/**
 * KTD10: whether a refresh would throw away something the user set up — a New row excluded or merged on the
 * displayed page (page-local, so read from `rows`; `allRows` keeps the defaults), or an unfinished
 * Already-ticketed row moved off the action it was built with.
 */
export function hasUnfinishedChoices(session: { rows: ReviewRowBase[]; allRows: ReviewRowBase[] }): boolean {
  const newRowChanged = session.rows.some(r => r.existingTicketKey === null && (r.included === false || r.memberIds !== undefined));
  const ticketedChanged = session.allRows.some(r =>
    r.existingTicketKey !== null && !isTicketedRowFinished(r) && r.defaultAction !== undefined && r.action !== r.defaultAction);
  return newRowChanged || ticketedChanged;
}
