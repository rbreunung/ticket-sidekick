// Greeting detection and the session continuity metadata of `@jira`'s import flows.
// Pure (vscode-free); re-exported through ../sessionState.ts.

/**
 * Exact-match (not substring/word-list) detection of an empty invocation or an obvious
 * greeting/help-shaped prompt — mirrors `isConfirmation()`/`isCancellation()`'s own
 * whole-normalized-string `Set` membership above, for the same reason: a substring or
 * per-word test on "hi" would misfire on legitimate operation text like "update HI-1
 * status", but an exact-string `Set` membership check never can, since the normalized whole
 * prompt "update hi-1 status" is never equal to "hi". See the specific-before-generic ordering
 * principle in
 * docs/solutions/logic-errors/confirm-cancel-word-list-broadening-swallows-domain-name-collisions.md
 * — this function sidesteps that hazard entirely by never doing substring matching in the first
 * place, rather than needing a live-domain-value check ordered ahead of it.
 */
const GREETING_OR_HELP_PHRASES = new Set<string>([
  '', 'hi', 'hello', 'hey', 'hiya', 'yo', 'howdy',
  'help', 'help me', '?', "what's up", 'whats up',
  'what can you do', 'what do you do', 'what can you help with', 'what can you help me with',
  'how does this work', 'how do i use this', 'how do i use you',
  'getting started', 'get started', 'what is this', 'who are you',
]);

export function isGreetingOrEmpty(prompt: string): boolean {
  const normalized = prompt.trim().toLowerCase().replace(/[!?.]+$/g, '').replace(/\s+/g, ' ').trim();
  return GREETING_OR_HELP_PHRASES.has(normalized);
}

/** The import sessions a response can start or continue, carried on `ChatResult.metadata`. */
export type JiraSessionKind =
  | 'await-issue-type'
  | 'stale-resolution-selection'
  | 'veracode-template'
  | 'veracode-review'
  | 'waltz-template'
  | 'waltz-review'
  | 'email-template'
  | 'email-review'
  | 'email-content'
  | 'email-cleanup';

export interface JiraSessionContinuity {
  kinds: JiraSessionKind[];
  /** The ticket an email was just added to or created as; carried so a later turn can name it. */
  lastTicketKey?: string;
}

/**
 * Code-review fix: `{ metadata: { jiraSession: { kinds, lastTicketKey } } }` was hand-copied at
 * ~22 call sites across `JiraParticipant.ts`, `contentHandler.ts`, `emailHandler.ts`, and
 * `fieldHandler.ts` — the docs/solutions best-practice this repo wrote after two real
 * regressions (a ticket-referencing branch that forgot to carry `lastTicketKey`) is a direct
 * result of that duplication. One constructor, one place to get the shape right.
 *
 * `kinds` defaults to `[]` (the "no session, but a ticket key is carried" sentinel — see
 * `JiraSessionContinuity`'s own doc comment); pass it explicitly for a branch that also starts
 * or continues a session.
 */
export function withLastTicket(
  ticketKey: string,
  kinds: JiraSessionKind[] = [],
): { metadata: { jiraSession: JiraSessionContinuity } } {
  return { metadata: { jiraSession: { kinds, lastTicketKey: ticketKey } } };
}
