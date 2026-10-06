// Follow-up suggestion chips, greeting detection, session continuity metadata.
// Pure (vscode-free); re-exported through ../sessionState.ts.

import { type WorkflowGraph } from '../../services/WorkflowService';
import type { Operation } from '../jira/llmHelpers';

// ---------------------------------------------------------------------------------------------
// Follow-up suggestion chips + greeting/empty-prompt detection (onboarding, U5) — pure logic so
// it stays Vitest-covered (KTD15). The vscode-coupled `participant.followupProvider` wiring and
// the pre-`parseIntent` greeting/empty check live in `JiraParticipant.ts`; both consume the
// exports below rather than re-deriving this logic.
// ---------------------------------------------------------------------------------------------

/** A `vscode.ChatFollowup`-shaped suggestion, without the `vscode` dependency — the participant
 * maps this 1:1 onto a real `vscode.ChatFollowup` in its `followupProvider`. */
export interface FollowupSuggestion {
  prompt: string;
  label?: string;
}

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

/** Discriminated "what just happened" shape `JiraParticipant.ts` round-trips through
 * `vscode.ChatResult.metadata` so its `followupProvider` can compute the right suggestion chips
 * for the response that was just streamed, without re-deriving state from response text. */
export type JiraFollowupState =
  // `branchKey`, when set, is the ticket key resolved from the current git branch — the only
  // source `computeJiraFollowups` may use for a "Show me {key}" chip (R4/AE3): never a fabricated
  // placeholder. `JiraParticipant.ts` resolves it once via `resolveTicketFromBranch()` before
  // building this state, keeping this function a pure read of its input.
  | { kind: 'greeting'; branchKey?: string }
  | { kind: 'fallback'; branchKey?: string }
  // `justDid`, when set, names the operation that just ran on `ticketKey` — omitted for a plain
  // ticket view, present for a write (e.g. `transition`) so the chip set below can leave out a
  // suggestion that would just repeat the action the user already took. `projectKey`/`issueType`
  // (KTD4) are the loaded ticket's own values, read once from the already-fetched issue, so the
  // "Discover workflow" chip below never needs a re-fetch.
  | { kind: 'loadedTicket'; ticketKey: string; projectKey: string; issueType: string; justDid?: Operation }
  // U5/R7-R8: a plain `searchJql` result (search or single-filter run). "Refine to my tickets"
  // (R7) is unconditional, so this case needs no field for it. "Refine to current sprint" (R8)
  // is conditional on every ticket sharing one project AND `ticketSidekick.jira.sprintBoardId`
  // resolving to a single active sprint — all of that resolution is async (project uniformity
  // from fetched tickets, `TicketService.getActiveSprintForBoard`), so `JiraParticipant.ts` does
  // it BEFORE constructing this state and hands this pure function only the answer: the resolved
  // sprint's name when eligible, `undefined` otherwise — eligibility and the name can't diverge,
  // so there is no separate boolean to keep in sync with it.
  // U6/R9: "Transition these…" chip eligibility — every ticket in the result shares one project
  // AND one issue type (computed synchronously in JiraParticipant.ts from `tickets[].projectKey`/
  // `.issueType`, same as the sprint check above). No name to carry (unlike sprintName) — the chip's
  // prompt text is fixed, the actual status options are computed only once the chip is clicked.
  | { kind: 'searchResults'; sprintName?: string; transitionChipEligible: boolean }
  | { kind: 'none' };

const JIRA_MAX_FOLLOWUPS = 3;

// R2: the greeting's "Show my filters" chip is a static, always-present entry, not one of
// KTD14's 2-3 example prompts — it doesn't compete with the branch-key chip for a slot the way
// two dynamically-generated examples would. One extra slot keeps both present instead of R2
// silently losing to KTD14's cap whenever a branch key also resolves.
const GREETING_MAX_FOLLOWUPS = 4;

/**
 * R6/KTD14: 2-3 example prompts, phrased as literal next messages a user could send, for a
 * major `@jira` response — including R8's unclassifiable-prompt fallback and R9's
 * greeting/empty-prompt response, which deliver their examples ONLY as these chips rather than
 * as separate inline prose guidance.
 */
export function computeJiraFollowups(state: JiraFollowupState): FollowupSuggestion[] {
  switch (state.kind) {
    case 'greeting': {
      // R4/AE3: no fabricated ticket key — "Show me {key}" only appears when the current git
      // branch actually resolved to one.
      const chips: FollowupSuggestion[] = [
        { prompt: 'create a ticket', label: 'Create a ticket' },
        { prompt: 'search my open tickets', label: 'Search tickets' },
      ];
      if (state.branchKey) {
        chips.push({ prompt: `show me ${state.branchKey}`, label: `Show me ${state.branchKey}` });
      }
      // R2: static chip, appended last — it invokes the listing intent rather than fetching
      // filters on every greeting (a greeting never touches the network today, and this chip
      // keeps it that way). Appended after the branch-key chip so the cap (below) favors the
      // existing "Show me {key}" suggestion over this one when both would otherwise fit.
      chips.push({ prompt: 'show my filters', label: 'Show my filters' });
      return chips.slice(0, GREETING_MAX_FOLLOWUPS);
    }
    case 'fallback': {
      // R1/R4: the comment chip is gone; same branch-key rule as greeting for the ticket chip.
      const chips: FollowupSuggestion[] = [
        { prompt: 'search my open tickets', label: 'Search tickets' },
      ];
      if (state.branchKey) {
        chips.push({ prompt: `show me ${state.branchKey}`, label: `Show me ${state.branchKey}` });
      }
      return chips.slice(0, JIRA_MAX_FOLLOWUPS);
    }
    case 'loadedTicket': {
      // Leave out a suggestion that would just repeat the write the user already performed
      // (e.g. don't offer "transition" right after `transition` succeeded). R1: the comment
      // chip is gone entirely. R6/R7: template/discover-workflow chips carry the loaded
      // ticket's own key/project/issue-type — both operations already have everything they
      // need, so neither can ever land on its own missing-parameter dead end (AE2).
      const chips: FollowupSuggestion[] = [];
      if (state.justDid !== 'transition') {
        chips.push({ prompt: `transition ${state.ticketKey}`, label: 'Transition it' });
      }
      if (state.justDid !== 'generateTemplate') {
        chips.push({
          prompt: `generate a template from ${state.ticketKey}`,
          label: `Create a template from ${state.ticketKey}`,
        });
      }
      // `issueType` is only ever populated where the caller already had the issue in hand
      // (loading/viewing a ticket) — deliberately never worth a fresh fetch just for this chip
      // (see JiraParticipant.ts's shared post-operation tail). Omit rather than render a chip
      // with a blank issue type.
      if (state.justDid !== 'discoverWorkflow' && state.issueType) {
        chips.push({
          prompt: `discover workflow ${state.projectKey} ${state.issueType}`,
          label: `Discover workflow for ${state.projectKey}/${state.issueType}`,
        });
      }
      return chips.slice(0, JIRA_MAX_FOLLOWUPS);
    }
    case 'searchResults': {
      // R7: always present, no eligibility check — narrowing to the current user's own tickets
      // is always a valid refinement of any search/filter result.
      const chips: FollowupSuggestion[] = [
        { prompt: 'refine to my tickets', label: 'Refine to my tickets' },
      ];
      // R8: only when JiraParticipant.ts already resolved a single eligible active sprint — the
      // chip's prompt names that sprint literally (the LLM intent parser can't know its name),
      // so there is nothing to offer when it isn't eligible.
      if (state.sprintName) {
        chips.push({
          prompt: `refine to sprint '${state.sprintName}'`,
          label: `Refine to sprint "${state.sprintName}"`,
        });
      }
      // U6/R9: only when every ticket in the result shares one project AND one issue type —
      // the exact phrase this feature's own intent routing recognizes (see llmHelpers.ts).
      if (state.transitionChipEligible) {
        chips.push({ prompt: 'transition these tickets', label: 'Transition these…' });
      }
      return chips.slice(0, JIRA_MAX_FOLLOWUPS);
    }
    case 'none':
      return [];
  }
}

/**
 * Sibling of `JiraFollowupState` on the same `vscode.ChatResult.metadata` channel, but for
 * session-continuity detection instead of follow-up chips: replaces matching the last rendered
 * response text against a visible `<!-- jira:TAG -->` HTML comment with a check against this
 * metadata read off `chatContext.history` (see `getActiveJiraSession` in `jira/ticketContext.ts`).
 * `workspaceState` still owns the actual session data — `kinds` is only a liveness flag, so a
 * response streams as many kinds as it left tags for today (some responses leave more than one,
 * e.g. a comment page that's simultaneously a valid `more-comments`-confirm target and a valid
 * `comment-list`-index target).
 */
// U3 finished migrating the six core flow handler files (createHandler.ts, contentHandler.ts,
// fieldHandler.ts, cleanupHandler.ts, loadHandler.ts, plus JiraParticipant.ts's own matching
// production/resume sites) onto this mechanism — every production site for a given kind below
// is metadata-based and its visible `<!-- jira:TAG -->` marker is gone. U4 finished the rest:
// the shared issue-type chat-ask (ticketContext.ts), report-import (reportImportHandler.ts,
// veracodeHandler.ts, waltzHandler.ts, emailHandler.ts), and template generation
// (templateGenerationHandler.ts). U4 also converted Bitbucket's ReviewSession/
// BitbucketCommentPreviewSession/SmartFallbackSession — see BitbucketSessionContinuity in
// reviewSessionState.ts for its sibling mechanism.
export type JiraSessionKind =
  | 'more-comments'
  | 'comment-list'
  | 'load-skipped'
  | 'creating'
  | 'selecting-create-option'
  | 'previewing'
  | 'resolution-selection'
  | 'transition-review'
  | 'guided-transition'
  | 'multi-transition'
  | 'selecting-filter'
  | 'listing-filters'
  | 'selecting-constraint-match'
  | 'bulk-update-review'
  | 'sprint-selection'
  | 'field-selection'
  | 'field-update-preview'
  | 'await-issue-type'
  | 'stale-resolution-selection'
  | 'veracode-template'
  | 'veracode-review'
  | 'waltz-template'
  | 'waltz-review'
  | 'email-template'
  | 'email-review'
  | 'email-content'
  | 'email-cleanup'
  | 'template-gen-await-name'
  | 'template-gen-type-pick'
  | 'template-gen-await-free-type'
  | 'template-gen-review'
  | 'template-gen-collision'
  | 'template-gen-offer-create'
  | 'template-gen-await-summary'
  | 'upload-review'
  | 'await-upload-ticket';

export interface JiraSessionContinuity {
  kinds: JiraSessionKind[];
  /** R13: the most recently referenced ticket key, carried on metadata instead of a visible
   * `<!-- @jira-ticket:KEY -->` marker. A branch that references a ticket but starts no session
   * returns `{ kinds: [], lastTicketKey }` — empty kinds keep every `getActiveJiraSession(...)?.kinds.includes(...)`
   * check false (no active session) while still letting `parseLastTicketFromContext` find the key. */
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

/** Result text for `jira_discoverWorkflow` — mirrors `handleDiscoverWorkflow`'s chat summary
 * (`src/participant/jira/workflowHandler.ts`) in plain returned text rather than a streamed
 * response, since a tool result is a single returned string, not a live chat stream. */
export function formatWorkflowDiscoveryMessage(
  projectKey: string,
  issueType: string,
  graph: WorkflowGraph,
  skippedStatuses: string[],
  preserved: string[],
): string {
  const statuses = Object.keys(graph);
  if (statuses.length === 0) {
    return `No tickets found for ${projectKey} / ${issueType} — workflow could not be sampled.`;
  }
  const lines = statuses.map((s) => {
    const targets = graph[s].map((t) => `${t.name} → ${t.to}`).join(', ');
    return `**${s}**: ${targets}`;
  });
  let summary = `Workflow discovered for **${projectKey} / ${issueType}** (${lines.length} statuses):\n\n${lines.join('\n\n')}\n\nSaved to \`.jira-workflow-cache.json\`.`;
  const trulySkipped = skippedStatuses.filter(s => !preserved.includes(s));
  if (preserved.length > 0) {
    summary += `\n\n_${preserved.length} status(es) had no tickets and kept cached transitions: ${preserved.join(', ')}._`;
  }
  if (trulySkipped.length > 0) {
    summary += `\n\n_${trulySkipped.length} status(es) had no tickets and no cached transitions: ${trulySkipped.join(', ')} — re-run jira_discoverWorkflow once tickets exist in those states._`;
  }
  return summary;
}
