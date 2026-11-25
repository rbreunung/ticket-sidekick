import { parsePrUrl } from '../../review/reviewSessionState';
import { sessionIdFor } from '../../sessions/sessionId';
import { findJiraKeyInText } from '../../utils/branchParser';

// What a pull request review board is asked for: the pull request, by its address. Two addresses of
// the same pull request (one ending in /overview, one in /diff, one with a query) are one source, so
// asking again finds the stored review. What the request names for the first step (a Jira key, the
// developer's own background text) rides along; it does not change which session the board is. vscode-free.

export const REVIEW_KIND = 'review';

const MAX_BACKGROUND_CHARS = 2000;

export interface ReviewPrefill {
  /** A Jira key the request named as the background. */
  ticketKey?: string;
  /** The developer's own background text (a goal or a focus) the request named. */
  background?: string;
}

export interface ReviewRecipe {
  /** The pull request's address up to its number, without what follows it (a tab name, a query). */
  url: string;
  host: string;
  project: string;
  repo: string;
  prId: number;
  prefill?: ReviewPrefill;
}

const EXAMPLES = 'https://bitbucket.example.com/projects/KEY/repos/repo/pull-requests/42 or https://bitbucket.org/workspace/repo/pull-requests/42';

/** The pull request a link names, or why it names none. */
export function parseReviewUrl(input: unknown): { ok: true; recipe: Omit<ReviewRecipe, 'prefill'> } | { ok: false; reason: string } {
  if (typeof input !== 'string' || input.trim() === '') return { ok: false, reason: 'Give the link of a Bitbucket pull request.' };
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return { ok: false, reason: `"${input.trim().slice(0, 200)}" is not a web address. A pull request link looks like ${EXAMPLES}.` };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, reason: 'A pull request link starts with https:// or http://.' };
  const parsed = parsePrUrl(url.href);
  const path = /^(.*?\/pull-requests\/\d+)(?:\/|$)/.exec(url.pathname);
  if (!parsed || !path) return { ok: false, reason: `That is not the link of a Bitbucket pull request. It looks like ${EXAMPLES}.` };
  return { ok: true, recipe: { url: `${url.protocol}//${url.host}${path[1]}`, host: url.host, project: parsed.project, repo: parsed.repo, prId: parsed.prId } };
}

function prefillOf(input: unknown): ReviewPrefill | undefined {
  const v = (typeof input === 'object' && input !== null ? input : {}) as { ticketKey?: unknown; background?: unknown };
  const ticketKey = typeof v.ticketKey === 'string' ? findJiraKeyInText(v.ticketKey.trim().toUpperCase()) : undefined;
  const background = typeof v.background === 'string' ? v.background.trim().slice(0, MAX_BACKGROUND_CHARS) : '';
  if (!ticketKey && !background) return undefined;
  return { ...(ticketKey ? { ticketKey } : {}), ...(background ? { background } : {}) };
}

/** The recipe of an open request `{ url, ticketKey?, background? }`, or why the board cannot open. */
export function reviewRecipeOf(input: unknown): { ok: true; recipe: ReviewRecipe } | { ok: false; reason: string } {
  const v = (typeof input === 'object' && input !== null ? input : {}) as { url?: unknown; prefill?: unknown };
  const parsed = parseReviewUrl(v.url);
  if (!parsed.ok) return parsed;
  // A stored recipe keeps its prefill under `prefill`; an open request names the fields directly.
  const prefill = prefillOf(v.prefill ?? input);
  return { ok: true, recipe: { ...parsed.recipe, ...(prefill ? { prefill } : {}) } };
}

/** The session id of the review of this pull request. */
export function reviewSessionId(recipe: Pick<ReviewRecipe, 'url'>): string {
  return sessionIdFor(REVIEW_KIND, recipe.url);
}
