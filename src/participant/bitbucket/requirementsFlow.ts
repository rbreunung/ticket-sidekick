import type { ReviewMode } from '../../bitbucket/IBitbucketClient';
import type { RequirementsSourceResult } from '../../services/TicketService';
import { buildChatCommandLink, buildSmartRerunCommand } from '../reviewSessionState';

// Pure and `vscode`-free: the decision about what a review does with a Jira ticket, and the lines
// and commands that go with each outcome. The participant file only executes the outcome.

/** What a review does about the ticket, decided once the PR (and so its title) is known. */
export type TicketStep =
  /** Nothing to do and nothing to say. */
  | { kind: 'none' }
  /** The user wrote `no ticket`: review as today, without a lookup. */
  | { kind: 'skip' }
  /** A title key in smart/deep with Jira configured: pause and ask. */
  | { kind: 'ask'; key: string }
  /** Use this ticket now (an explicit key in smart/deep with Jira configured). */
  | { kind: 'run'; key: string }
  /** Quick/standard: the title has a key — say how to check it. */
  | { kind: 'hint'; key: string }
  /** Quick/standard: an explicit key was given but only smart and deep use tickets. */
  | { kind: 'ignored-explicit'; key: string }
  /** Smart/deep: a key is known but Jira is not configured. */
  | { kind: 'not-configured'; key: string }
  /** Smart/deep: no key in the prompt or the PR title. */
  | { kind: 'no-key' };

export interface TicketStepInput {
  mode: ReviewMode;
  /** The Jira key written in the prompt, if any. */
  explicitKey: string | undefined;
  /** The user wrote `no ticket`. */
  skipTicket: boolean;
  /** The first Jira key in the PR title, if any. */
  titleKey: string | undefined;
  jiraConfigured: boolean;
}

export function decideTicketStep(input: TicketStepInput): TicketStep {
  const { mode, explicitKey, skipTicket, titleKey, jiraConfigured } = input;
  if (skipTicket) return { kind: 'skip' };

  if (mode === 'quick' || mode === 'standard') {
    if (explicitKey) return { kind: 'ignored-explicit', key: explicitKey };
    if (titleKey && jiraConfigured) return { kind: 'hint', key: titleKey };
    return { kind: 'none' };
  }

  if (explicitKey) return jiraConfigured ? { kind: 'run', key: explicitKey } : { kind: 'not-configured', key: explicitKey };
  if (titleKey) return jiraConfigured ? { kind: 'ask', key: titleKey } : { kind: 'not-configured', key: titleKey };
  return { kind: 'no-key' };
}

/** Puts the directive right after the PR URL (before any trailing `--`/`question:` text, which would swallow it). */
function withDirective(prompt: string, directive: string): string {
  const url = /https?:\/\/\S+/.exec(prompt);
  if (!url) return `${directive} ${prompt}`;
  const end = url.index + url[0].length;
  return `${prompt.slice(0, end)} ${directive}${prompt.slice(end)}`;
}

/** The pause: two clickable commands, each a complete re-run of this review (nothing is stored between turns). */
export function buildTicketPause(key: string, originalPrompt: string): string {
  const prompt = originalPrompt.trim();
  const use = buildChatCommandLink(`Use ${key}`, '@bitbucket', withDirective(prompt, key));
  const skip = buildChatCommandLink('Skip', '@bitbucket', withDirective(prompt, 'no ticket'));
  return (
    `Found **${key}** in the PR title. Check this PR against that ticket?\n\n` +
    `${use} · ${skip}\n\n` +
    `_To use a different ticket, put its key in the command._`
  );
}

export function buildTicketHintLine(key: string, prUrl: string): string {
  return `_Ticket ${key} found in the PR title. To check this PR against it, run \`${buildSmartRerunCommand(prUrl, key)}\`._`;
}

export function buildIgnoredTicketLine(key: string): string {
  return `_Ticket reference ${key} ignored — only smart and deep reviews use tickets. Add \`smart\` or \`deep\` to check requirements._`;
}

export function buildNotConfiguredLine(key: string): string {
  return `_Found ${key} but Jira isn't configured, so requirements aren't checked. Set it up with \`@jira check\`._`;
}

export function buildNoKeyLine(): string {
  return '_No Jira key in the PR title, so requirements aren\'t checked. Put a key in the command to use a ticket._';
}

/** One line saying why a ticket could not be read; the review then runs without it. */
export function buildTicketFailureLine(key: string, failure: Extract<RequirementsSourceResult, { ok: false }>): string {
  switch (failure.reason) {
    case 'not-found':
      return `_Ticket ${key} was not found in Jira — reviewing without it._`;
    case 'auth':
      return `_Jira rejected the credentials while reading ${key} — reviewing without it. Check them with \`@jira check\`._`;
    default:
      return `_Could not read ${key} from Jira (${failure.message.replace(/\s+/g, ' ').slice(0, 120)}) — reviewing without it._`;
  }
}

/** When the key written in the prompt does not exist but the PR title names another one, point to it. */
export function buildTitleKeyAlternativeLine(titleKey: string, prUrl: string): string {
  return `_The PR title names ${titleKey} instead. To check against it, run \`${buildSmartRerunCommand(prUrl, titleKey)}\`._`;
}

/** How long the ticket read may take before the review goes on without it. */
export const TICKET_READ_TIMEOUT_MS = 20000;

/**
 * Runs the ticket read so it can never hold the review up or sink it: a read that does not settle in
 * time, or that throws, becomes an `error` failure that the usual failure line names.
 */
export async function readTicketGuarded(
  read: () => Promise<RequirementsSourceResult>,
  timeoutMs: number = TICKET_READ_TIMEOUT_MS,
): Promise<RequirementsSourceResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<RequirementsSourceResult>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, reason: 'error', message: 'timed out' }), timeoutMs);
  });
  try {
    return await Promise.race([read(), timeout]);
  } catch (err) {
    return { ok: false, reason: 'error', message: err instanceof Error ? err.message : 'unexpected error' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * A goal correction checks the stored diff, so extra files are read at the commit the review ran against.
 * `changed` is true when the PR has moved on since (both hashes known and different).
 */
export function resolveGoalCommit(storedHash: string | undefined, currentHash: string): { commit: string; changed: boolean } {
  return { commit: storedHash ?? currentHash, changed: storedHash !== undefined && storedHash !== currentHash };
}

export function buildPrMovedOnLine(): string {
  return '_The PR has new commits since this review, so this check covers the version that was reviewed. Re-run the review for an up-to-date check._';
}
