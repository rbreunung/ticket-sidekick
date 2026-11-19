import { TICKET_ID_PATTERN, findJiraKeyMatch } from '../utils/branchParser';
import { isCancellation } from '../utils/chatPrimitives';
import type { ReviewMode } from '../bitbucket/IBitbucketClient';
import type { PersonaId } from '../services/PrReviewService';
import {
  ALL_PERSONA_IDS,
  neutralizeMarkdownLinks,
} from '../review/reviewSessionState';

// Chat-only helpers of the deprecated `@bitbucket` participant: prompt parsing, follow-up
// intents, command links and follow-up chips. The review core lives in `src/review/`.

export type SmartFallbackChoice =
  | { kind: 'all'; personas: PersonaId[] }
  | { kind: 'standard'; personas: [] }
  | { kind: 'unrecognized' };

/**
 * Pure parse of the user's reply to the smart-fallback question into a persona set. `all`
 * resolves to all four personas, `standard` resolves to an empty persona set (standard pass
 * only), anything else is `unrecognized` so the caller re-prompts without losing the session.
 */
export function parseSmartFallbackReply(prompt: string): SmartFallbackChoice {
  const normalized = prompt.trim().toLowerCase();
  if (/\ball\b/.test(normalized)) {
    return { kind: 'all', personas: [...ALL_PERSONA_IDS] };
  }
  if (/\bstandard\b/.test(normalized)) {
    return { kind: 'standard', personas: [] };
  }
  return { kind: 'unrecognized' };
}

export function hasPrUrl(prompt: string): boolean {
  return /https?:\/\/\S+\/pull-requests\/\d+/.test(prompt);
}

/** `@bitbucket usage` typed as plain text: exactly the word, never alongside a PR URL. */
export function isUsageRequest(prompt: string): boolean {
  return !hasPrUrl(prompt) && /^usage$/i.test(prompt.trim());
}

/**
 * Builds a raw `[label](command:workbench.action.chat.open?<encoded>)` markdown link that,
 * when clicked, re-submits `replyText` to this participant exactly as if the user had typed it
 * (R5) — reusing VS Code's built-in `workbench.action.chat.open` command rather than a new
 * registered wrapper command (KTD2).
 *
 * `label` is neutralized (see `neutralizeMarkdownLinks()` below) before being embedded: a label
 * built from externally-influenced text (a PR title, an LLM-generated finding heading, …) that
 * contains an unneutralized `]` would close the `[label]` early, letting the rest of that text
 * open a second, attacker-chosen `(command:...)` link of its own right next to this legitimate
 * one — not merely garbled rendering, but a second live command. Callers therefore never need to
 * pre-sanitize a label themselves.
 *
 * Pure string building only — this never touches `vscode.MarkdownString` (KTD5). Every call site
 * that assembles a `MarkdownString` from output containing one or more of these links MUST set
 * `.isTrusted = { enabledCommands: ['workbench.action.chat.open'] }` on that `MarkdownString`
 * before calling `stream.markdown(...)`, mirroring the existing `notConfigured` trust-gate
 * pattern in `BitbucketParticipant.ts`. Without that, VS Code renders the link as inert plain
 * text instead of a clickable command.
 */
export function buildChatCommandLink(label: string, participantId: '@bitbucket', replyText: string): string {
  const safeLabel = neutralizeMarkdownLinks(label);
  const query = `${participantId} ${replyText}`;
  // encodeURIComponent leaves ( and ) literal; an unbalanced ) would end the markdown link destination early.
  const encodedArgs = encodeURIComponent(JSON.stringify({ query, isPartialQuery: false })).replace(/\(/g, '%28').replace(/\)/g, '%29');
  return `[${safeLabel}](command:workbench.action.chat.open?${encodedArgs})`;
}

/**
 * U7/R10/KTD3: wraps each finding's own heading (returned by `PrReviewService.formatReview()`
 * alongside its assembled markdown) in a command-link resubmitting `#<id>` — the exact text
 * `parseFollowUpIntent()`'s explain path already accepts, so clicking a finding's heading produces
 * the same answer as typing a reference to it (R5). Every finding's heading is already unique (each
 * embeds its own `#<id>`), so a plain string replace can't cross-match a different finding.
 * `formatReview()` already neutralized every untrusted string embedded in its markdown (title, file
 * path, PR title/author) before this function ever runs, so wrapping the result in a trusted
 * MarkdownString (the caller's job, `BitbucketParticipant.ts`) is safe. Pure — moved here (rather
 * than staying a `BitbucketParticipant.ts`-local function) so it's Vitest-loadable per CLAUDE.md's
 * testing rule (code-review fix).
 */
export function composeReviewOutput(result: { markdown: string; findingHeadings: Array<{ id: number; heading: string }> }): string {
  let output = result.markdown;
  for (const { id, heading } of result.findingHeadings) {
    // Code-review fix: a string replacement argument gives $&, $$, $`, $', and $<name> special
    // meaning in JS — and `heading` (LLM-generated finding text, not filtered for these tokens)
    // is embedded inside the replacement string via buildChatCommandLink. A heading containing
    // one of those sequences would corrupt this finding's rendered row. A replacer function
    // treats the whole thing as a literal string, no matter what it contains.
    output = output.replace(heading, () => buildChatCommandLink(heading, '@bitbucket', `#${id}`));
  }
  return output;
}

/** The exact command that re-runs a PR review as smart with a ticket — what the hint line and its chip show. */
export function buildSmartRerunCommand(prUrl: string, key: string): string {
  return `review smart ${prUrl} ${key}`;
}

/**
 * Locate the upfront-question delimiter (`question:` prefix or a standalone `--`
 * marker) in the RAW prompt and return its span plus the extracted question text.
 * `extractPromptDirectives` calls this once and derives both the question and the prompt
 * without it from the same span — running two independently-normalized regex passes
 * previously let them disagree (a `--`
 * inside a URL/repo slug like `api--service` could be picked up by one function and
 * not the other, and a trailing newline could defeat one function's `$`-anchored
 * match while the other's `.trim()`-then-match still succeeded).
 *
 * A `--` is only treated as a delimiter when it is whitespace- or
 * start-of-string-delimited, and only when it falls outside every URL span in the
 * prompt — so a `--` embedded in a URL/slug is never mistaken for the marker.
 * Single-line assumption: the question is taken as the rest of the line after the
 * delimiter, stopping at the next newline (or end of string) — a question is not
 * expected to span multiple lines. The capture also stops at the start of the next
 * PR URL (whichever comes first — newline or URL), so a `question: … <url>` prompt
 * (question before the URL) doesn't swallow the URL into the question text; a
 * `<url> -- …` prompt (URL before the question) is unaffected since no URL starts
 * at or after the capture's start in that ordering.
 */
function findUpfrontQuestionMatch(prompt: string): { question: string; start: number; end: number } | null {
  const urlSpans: Array<[number, number]> = [];
  for (const m of prompt.matchAll(/https?:\/\/\S+/g)) {
    if (m.index === undefined) continue;
    urlSpans.push([m.index, m.index + m[0].length]);
  }
  const insideUrl = (idx: number) => urlSpans.some(([s, e]) => idx >= s && idx < e);

  const captureRestOfLine = (from: number): { question: string; end: number } => {
    const nl = prompt.indexOf('\n', from);
    let end = nl === -1 ? prompt.length : nl;
    const nextUrlStart = urlSpans.find(([s]) => s >= from)?.[0];
    if (nextUrlStart !== undefined && nextUrlStart < end) end = nextUrlStart;
    return { question: prompt.slice(from, end).trim(), end };
  };

  for (const m of prompt.matchAll(/question:\s*/gi)) {
    if (m.index === undefined || insideUrl(m.index)) continue;
    const { question, end } = captureRestOfLine(m.index + m[0].length);
    return { question, start: m.index, end };
  }

  for (const m of prompt.matchAll(/(?:^|\s)--\s*/g)) {
    if (m.index === undefined) continue;
    const dashStart = m[0].startsWith('--') ? m.index : m.index + 1;
    if (insideUrl(dashStart)) continue;
    const { question, end } = captureRestOfLine(m.index + m[0].length);
    return { question, start: dashStart, end };
  }

  return findInformalQuestionMatch(prompt, urlSpans);
}

/** Words that may precede an informal question on its line; they stay in the prompt. */
const MODE_LEAD_WORD = /^(?:review|quick|standard|smart|deep)\b\s*/i;
const NO_TICKET_LEAD = /^no\s+ticket\b\s*/i;
const TICKET_KEY_LEAD = new RegExp(`^${TICKET_ID_PATTERN.source}(?![A-Za-z0-9-])\\s*`);
const MIN_INFORMAL_QUESTION_WORDS = 3;

/**
 * An upfront question written as a plain sentence ending in `?`, with no delimiter: the last such
 * sentence (at least three words) found outside every URL span, so a query string such as `?w=1`
 * on a PR URL is never a question. A PR URL also ends a sentence. Mode words, `no ticket` and a
 * Jira key at the start of the sentence stay in the prompt rather than becoming part of the
 * question. Only reached when neither the `question:` nor the `--` form matched.
 */
function findInformalQuestionMatch(
  prompt: string,
  urlSpans: Array<[number, number]>,
): { question: string; start: number; end: number } | null {
  let masked = '';
  let last = 0;
  for (const [s, e] of urlSpans) {
    masked += prompt.slice(last, s) + '\n'.repeat(e - s);
    last = e;
  }
  masked += prompt.slice(last);

  let found: { question: string; start: number; end: number } | null = null;
  for (const m of masked.matchAll(/(?:[^.!?\n]|[.!](?=\S))*\?/g)) {
    if (m.index === undefined) continue;
    let start = m.index;
    const end = m.index + m[0].length;
    for (;;) {
      const rest = prompt.slice(start, end);
      const lead = /^\s+/.exec(rest) ?? MODE_LEAD_WORD.exec(rest) ?? NO_TICKET_LEAD.exec(rest) ?? TICKET_KEY_LEAD.exec(rest);
      if (!lead || lead[0].length === 0) break;
      start += lead[0].length;
    }
    const question = prompt.slice(start, end).trim();
    if (question.split(/\s+/).length >= MIN_INFORMAL_QUESTION_WORDS) found = { question, start, end };
  }
  return found;
}

/**
 * What a new-review prompt asks for, beyond the PR URL. Extraction runs in a fixed order so a key,
 * `no ticket` or mode word inside the question or URL never acts: the upfront question first, then
 * PR URLs, then `no ticket`, then the first Jira key in what remains. `remainder` is what mode
 * detection should read. `no ticket` wins over a key.
 */
export interface PromptDirectives {
  question: string | undefined;
  ticketKey: string | undefined;
  skipTicket: boolean;
  remainder: string;
}

export function extractPromptDirectives(prompt: string): PromptDirectives {
  const match = findUpfrontQuestionMatch(prompt);
  let text = match ? `${prompt.slice(0, match.start)} ${prompt.slice(match.end)}` : prompt;
  text = text.replace(/https?:\/\/\S+/g, ' ');

  const noTicket = /(?<![A-Za-z0-9])no\s+ticket(?![A-Za-z0-9])/i;
  const skipTicket = noTicket.test(text);
  text = text.replace(noTicket, ' ');

  const keyMatch = findJiraKeyMatch(text);
  if (keyMatch) text = `${text.slice(0, keyMatch.index)} ${text.slice(keyMatch.index + keyMatch.key.length)}`;

  return {
    question: match?.question,
    ticketKey: skipTicket ? undefined : keyMatch?.key,
    skipTicket,
    remainder: text.replace(/\s+/g, ' ').trim(),
  };
}

export type FollowUpIntent =
  | { kind: 'goal'; goal: string }
  | { kind: 'copy'; targets: number[] | 'all' }
  | { kind: 'add'; targets: number[] | 'all'; note: string }
  | { kind: 'explain'; findingRef: number | null; question: string };

/** Words a copy command may carry besides `copy`/`share` and `#N` references (KTD2). */
const COPY_FILLER_WORDS = new Set(['for', 'to', 'with', 'and', 'teams', 'team', 'chat', 'all', 'the', 'finding', 'findings', 'review', 'please']);

/**
 * "Copy for Teams" (KTD2): a strict whole-message command — `copy`/`share`, then only filler words
 * and `#N` references — so a question that merely mentions copying ("can you copy the logic from
 * #2?") is answered as a question instead of being swallowed by a keyword match.
 */
function parseCopyCommand(message: string): FollowUpIntent | undefined {
  const words = message.trim().replace(/[,.!]+/g, ' ').split(/\s+/).filter(Boolean);
  if (words.length === 0 || !/^(?:copy|share)$/i.test(words[0])) return undefined;
  const numbers: number[] = [];
  let hasAll = false;
  for (const word of words.slice(1)) {
    const ref = /^#(\d+)$/.exec(word);
    if (ref) numbers.push(parseInt(ref[1], 10));
    else if (COPY_FILLER_WORDS.has(word.toLowerCase())) hasAll ||= word.toLowerCase() === 'all';
    else return undefined;
  }
  return { kind: 'copy', targets: numbers.length > 0 && !hasAll ? [...new Set(numbers)] : 'all' };
}

/**
 * The user stating the real goal of the ticket ("the goal is actually …", "goal: …"). Start-anchored,
 * so a question that merely mentions the goal ("what is the goal of this PR?") stays a question.
 * An empty goal comes back as ''.
 */
function parseGoalStatement(message: string): FollowUpIntent | undefined {
  const text = message.trim();
  const sentence = /^(?:(?:actually|no|well)[\s,]+)?the\s+(?:(?:real|actual|true)\s+)?goal\s+(?:is|was|should\s+be)\b[\s:,-]*(?:actually\b[\s:,-]*)?([\s\S]*)$/i.exec(text);
  const label = /^goal\s*:\s*([\s\S]*)$/i.exec(text);
  const goal = (sentence ?? label)?.[1];
  // A trailing `?` makes it a question about the goal, not a correction of it.
  if (goal !== undefined && /\?\s*$/.test(goal)) return undefined;
  return goal === undefined ? undefined : { kind: 'goal', goal: goal.trim() };
}

export function parseFollowUpIntent(message: string, options: { hasRequirements?: boolean } = {}): FollowUpIntent {
  const copy = parseCopyCommand(message);
  if (copy) return copy;

  // Checked before `add`: a goal such as "to add logging to the review" must not read as an add command.
  if (options.hasRequirements) {
    const goal = parseGoalStatement(message);
    if (goal) return goal;
  }

  // R20: only a request to add/post findings *to the review* is an add — a question that merely
  // mentions both words ("can you review whether #2 would add latency?") is answered instead.
  // "to PR review" (an optional "pr" before "review") counts too, e.g. "add #2 to PR review".
  if (/\b(?:add|post)\b.*?\bto\s+(?:the\s+)?(?:pr\s+)?review\b/i.test(message)) {
    const numberMatches = [...message.matchAll(/#(\d+)/g)];
    const hasAll = /\ball\b/i.test(message);
    const targets: number[] | 'all' =
      numberMatches.length > 0 && !hasAll
        ? [...new Set(numberMatches.map((m) => parseInt(m[1], 10)))]
        : 'all';
    const note = message
      .replace(/#\d+/g, '')
      // Strip the whole phrase first so "PR" from "to PR review" doesn't leak into the note.
      .replace(/\bto\s+(?:the\s+)?(?:pr\s+)?review\b/gi, '')
      .replace(/\b(?:can|could|would|will) you\b/gi, '')
      .replace(/\badd\b|\bpost\b|\band\b|\bto\b|\bthe\b|\breview\b|\ball\b|\bfindings?\b|\bplease\b/gi, '')
      .replace(/[,;—–?]+/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    return { kind: 'add', targets, note };
  }

  const m = message.match(/#(\d+)/);
  const findingRef = m ? parseInt(m[1], 10) : null;
  const question = message.replace(/#(\d+)/g, 'this finding').trim();
  return { kind: 'explain', findingRef, question };
}

// ---------------------------------------------------------------------------------------------
// Follow-up suggestion chips (onboarding, U5) — pure logic so it stays Vitest-covered (KTD15).
// The vscode-coupled `participant.followupProvider` wiring lives in `BitbucketParticipant.ts`.
// Empty/greeting-prompt detection (`isGreetingOrEmpty`) lives in `src/utils/chatPrimitives.ts`.
// ---------------------------------------------------------------------------------------------

/** A `vscode.ChatFollowup`-shaped suggestion, without the `vscode` dependency — the participant
 * maps this 1:1 onto a real `vscode.ChatFollowup` in its `followupProvider`. */
export interface BitbucketFollowupSuggestion {
  prompt: string;
  label?: string;
}

/** Discriminated "what just happened" shape `BitbucketParticipant.ts` round-trips through
 * `vscode.ChatResult.metadata` so its `followupProvider` can compute the right suggestion chips
 * for the response that was just streamed, without re-deriving state from response text. */
export type BitbucketFollowupState =
  | { kind: 'greeting' }
  | { kind: 'reviewCompleted'; findingCount: number; ticketHint?: { key: string; prUrl: string } }
  | { kind: 'none' };

/**
 * Sibling of `BitbucketFollowupState` on the same `vscode.ChatResult.metadata` channel, but for
 * session-continuity detection instead of follow-up chips. Replaces matching the last rendered response text against a visible
 * `<!-- bitbucket:TAG -->` HTML comment with a check against this metadata read off
 * `chatContext.history` (see `getActiveBitbucketSession` in `BitbucketParticipant.ts`).
 * `workspaceState` still owns the actual session data — `kinds` is only a liveness flag.
 */
export type BitbucketSessionKind =
  | 'comment-preview'
  | 'smart-fallback-session'
  | 'review-session';

export interface BitbucketSessionContinuity {
  kinds: BitbucketSessionKind[];
}

/** Cap on *action* chips; the end-session chips below are appended outside it. */
const BITBUCKET_MAX_FOLLOWUPS = 3;

/** The three `workspaceState` keys that hold a live Bitbucket session. */
export const BITBUCKET_SESSION_KEYS = [
  'bitbucket.session.review',
  'bitbucket.session.commentPreview',
  'bitbucket.session.smartFallback',
] as const;

/** Which `workspaceState` key holds the data behind each session kind. */
const SESSION_KEY_BY_KIND: Record<BitbucketSessionKind, (typeof BITBUCKET_SESSION_KEYS)[number]> = {
  'review-session': 'bitbucket.session.review',
  'comment-preview': 'bitbucket.session.commentPreview',
  'smart-fallback-session': 'bitbucket.session.smartFallback',
};

/** True when the data behind at least one of the session kinds is still stored — the chat history
 * can keep a session marker after the stored session was cleared. */
export function hasStoredBitbucketSession(
  kinds: readonly BitbucketSessionKind[] | undefined,
  store: { get(key: string): unknown },
): boolean {
  return (kinds ?? []).some((kind) => store.get(SESSION_KEY_BY_KIND[kind]) !== undefined);
}

/**
 * Clears every Bitbucket session. Takes any store with `update` (and `get`, when it has one, so
 * keys that hold nothing are not rewritten) to stay free of `vscode`.
 */
export async function endBitbucketSessions(
  store: { get?(key: string): unknown; update(key: string, value: unknown): PromiseLike<void> | void },
): Promise<void> {
  for (const key of BITBUCKET_SESSION_KEYS) {
    if (store.get && store.get(key) === undefined) continue;
    await store.update(key, undefined);
  }
}

/**
 * Whole-message "leave the review session" request: `done` plus the shared cancel words.
 * `done` is deliberately not added to the shared `isCancellation` — its other callers match
 * against live Jira option names, and a status can be called `Done`.
 */
export function isEndSessionRequest(prompt: string): boolean {
  return prompt.trim().toLowerCase() === 'done' || isCancellation(prompt);
}

/**
 * A review start with nothing to review: the `review` command without a PR URL, or a message
 * that is only a mode word. Whole-message only, so "is this quick to fix?" stays a follow-up.
 */
export function isReviewStartWithoutUrl(prompt: string, command: string | undefined): boolean {
  if (hasPrUrl(prompt)) return false;
  return command === 'review' || /^(quick|smart|deep)$/i.test(prompt.trim());
}

/** End-session chips for a live session of the given kinds: Post it/Cancel for a preview,
 * Cancel for the smart-fallback question, Done for a review session. */
function endSessionChips(kinds: readonly BitbucketSessionKind[] | undefined): BitbucketFollowupSuggestion[] {
  if (!kinds) return [];
  if (kinds.includes('comment-preview')) {
    return [{ prompt: 'post it', label: 'Post it' }, { prompt: 'cancel', label: 'Cancel' }];
  }
  if (kinds.includes('smart-fallback-session')) return [{ prompt: 'cancel', label: 'Cancel' }];
  if (kinds.includes('review-session')) return [{ prompt: 'done', label: 'Done' }];
  return [];
}

/**
 * R6/KTD14: 2-3 example prompts, phrased as literal next messages a user could send, for a
 * major `@bitbucket` response. There is no separate R8-equivalent "unrecognized operation"
 * fallback for `@bitbucket` to reroute — it has no LLM intent classifier, only a PR-URL match, and its existing "Point me at a PR to review" guidance already
 * covers a non-greeting, non-URL prompt; R9's greeting/empty-prompt case is the one this
 * function's `'greeting'` state covers.
 */
export function computeBitbucketFollowups(
  state: BitbucketFollowupState,
  sessionKinds?: readonly BitbucketSessionKind[],
): BitbucketFollowupSuggestion[] {
  return [...actionChips(state), ...endSessionChips(sessionKinds)];
}

function actionChips(state: BitbucketFollowupState): BitbucketFollowupSuggestion[] {
  switch (state.kind) {
    case 'greeting':
      return [
        { prompt: 'check', label: 'Check my connection' },
      ];
    case 'reviewCompleted': {
      // KTD7: sharing works for every review — "No issues found" is worth sharing too.
      const copyChip = { prompt: 'copy for teams', label: 'Copy for Teams' };
      // A quick or standard review of a PR that names a Jira ticket: one click re-runs it as smart with the ticket.
      const ticketChip = state.ticketHint
        ? { prompt: buildSmartRerunCommand(state.ticketHint.prUrl, state.ticketHint.key), label: `Check against ${state.ticketHint.key}` }
        : undefined;
      if (state.findingCount === 0) {
        // R10: no one-click "ask a question" follow-up — a real Q&A flow needs its own
        // review, and asking a question is relevant mid-review, not as a post-review chip.
        return ticketChip ? [ticketChip, copyChip] : [copyChip];
      }
      // The ticket chip takes the place of "Explain finding #1" (typing #1 does the same) to keep three chips.
      return [
        ...(ticketChip ? [ticketChip] : []),
        { prompt: 'add all findings to review', label: 'Add findings to review' },
        ...(ticketChip ? [] : [{ prompt: 'explain finding #1', label: 'Explain finding #1' }]),
        copyChip,
      ].slice(0, BITBUCKET_MAX_FOLLOWUPS);
    }
    case 'none':
      return [];
  }
}

