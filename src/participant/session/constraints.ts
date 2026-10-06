// JQL constraint building and resolution, filter listings, the not-configured message.
// Pure (vscode-free); re-exported through ../sessionState.ts.

import type { IJiraClient, JiraFilter, JiraFilterSource } from '../../jira/IJiraClient';
import type { JiraConfig } from '../../services/ConfigService';
import { formatBulletList, isCancellation } from './primitives';
import { PendingSearchConstraints } from './sessionTypes';

// The "no resolvable issue type" sentinel — never a real Jira issue type name. Signals that
// nothing was fetched or configured, so the caller must ask the user rather than guess.
export const NO_ISSUE_TYPE = '';

export function selectDefaultIssueType(issueTypes: string[]): string {
  return (
    issueTypes.find(t => t === 'Story') ??
    issueTypes.find(t => t === 'Task') ??
    issueTypes[0] ??
    NO_ISSUE_TYPE
  );
}

// Resolves a template's own configured issue type, falling back to the first fetched project
// issue type, or the never-guess sentinel when neither is available.
export function resolveTemplateIssueType(explicit: string | undefined, issueTypes: string[]): string {
  return explicit ?? issueTypes[0] ?? NO_ISSUE_TYPE;
}

// Renders a template/type-list entry, replacing the never-guess sentinel with an explicit
// "you'll be asked to type it" indicator instead of a blank or fabricated-looking value.
export function formatIssueTypeOptionLabel(issueType: string): string {
  return issueType === NO_ISSUE_TYPE ? '_you will be asked to type it_' : issueType;
}

// Same sentinel, for the inline "as **Bug**" phrasing used outside numbered lists.
export function formatIssueTypeInlinePhrase(issueType: string): string {
  return issueType === NO_ISSUE_TYPE ? formatIssueTypeOptionLabel(issueType) : `**${issueType}**`;
}

export function buildTeamJql(teamJql: string, extraJql: string | null): string {
  const extra = extraJql ? ` AND (${extraJql})` : ' AND resolution is NULL';
  return `(${teamJql})${extra}`;
}

/**
 * Already-resolved constraint values to AND onto a base JQL string. Resolving a human-typed
 * name (a fixVersion name, a sprint name, an assignee's display name) to this shape — including
 * disambiguating a name that matches multiple candidates — is a different unit's job; this type
 * only carries the resolved value.
 *
 * - `fixVersion`: the version's name (e.g. "Release 3.2"), matched with `fixVersion = "<name>"`.
 * - `sprint`: the sprint's *name*, not its numeric id — chosen for consistency with `fixVersion`
 *   and `assignee` (both name-based) and because callers resolve a sprint from natural-language
 *   text the same way they resolve a fixVersion; matched with `Sprint = "<name>"`.
 * - `assignee`: an account identifier/display name, or the literal string `"me"`, which maps to
 *   `assignee = currentUser()` — the same mapping `INTENT_PROMPT`'s "my tickets" guidance already
 *   documents for the LLM-facing JQL translation.
 */
export interface JqlConstraints {
  fixVersion?: string;
  sprint?: string;
  assignee?: string;
}

// Quotes a JQL string literal, escaping backslashes and double quotes so a constraint value
// (which may originate from an LLM's own inference, not just human-typed chat text) cannot
// terminate its clause early and inject additional JQL. Backslashes are escaped first so an
// escaped quote's own backslash isn't re-escaped.
function quoteJqlValue(value: string): string {
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${escaped}"`;
}

/**
 * ANDs a fixVersion/sprint/assignee constraint set onto a base JQL string, generalizing
 * `buildTeamJql`'s `(base) AND (extra)` wrapping pattern to any number of resolved constraints.
 * Every value is quoted/escaped via `quoteJqlValue` before interpolation. Zero constraints
 * provided returns `baseJql` unchanged.
 */
export function buildConstraintJql(baseJql: string, constraints: JqlConstraints): string {
  const clauses: string[] = [];

  if (constraints.fixVersion) {
    clauses.push(`fixVersion = ${quoteJqlValue(constraints.fixVersion)}`);
  }
  if (constraints.sprint) {
    clauses.push(`Sprint = ${quoteJqlValue(constraints.sprint)}`);
  }
  if (constraints.assignee) {
    clauses.push(
      constraints.assignee === 'me' ? 'assignee = currentUser()' : `assignee = ${quoteJqlValue(constraints.assignee)}`,
    );
  }

  if (clauses.length === 0) {
    return baseJql;
  }
  return `(${baseJql}) AND (${clauses.join(' AND ')})`;
}

/**
 * U4/R11: a single resolved-JQL-value candidate offered in the ambiguous-match pick-list — `label`
 * is what's shown/matched against a typed reply, `value` is what actually gets ANDed onto the JQL
 * via `buildConstraintJql` once chosen (usually the same string, but e.g. a sprint candidate's
 * label can carry its state — "Sprint 5 (active)" — while `value` stays the bare sprint name
 * `buildConstraintJql` expects).
 */
export interface ConstraintMatchOption {
  label: string;
  value: string;
}

/**
 * U4/R11: ONE ambiguous-match pick-list session, parameterized by `kind` rather than three
 * separate session types — the picker behavior (numbered/exact-name reply, cancel) is identical
 * across fixVersion/sprint/assignee. `baseJql`/`jqlLabel` are the filter's (or prior search's) own
 * JQL/label the resolved value eventually gets ANDed onto; `resolvedConstraints` carries whatever
 * earlier constraint(s) in the same message already resolved before this ambiguity was hit;
 * `remainingConstraints` carries whichever named constraint(s) still need resolving after this pick
 * is made (e.g. a message naming both a fixVersion and a sprint, where the fixVersion resolved
 * cleanly but the sprint name was ambiguous — this session's `kind` is 'sprint', and
 * `remainingConstraints` is empty since sprint was the last one to resolve).
 */
export interface ConstraintAmbiguitySession {
  kind: 'fixVersion' | 'sprint' | 'assignee';
  options: ConstraintMatchOption[];
  baseJql: string;
  jqlLabel: string;
  resolvedConstraints: JqlConstraints;
  remainingConstraints: PendingSearchConstraints;
}

/** Resolves a reply to a `ConstraintAmbiguitySession`'s pick-list the same way `parseFilterSelection`
 * resolves `FilterSelectionSession`'s — an exact (case-insensitive) label match wins over the
 * generic cancellation word list (so a candidate literally named "Stop" or "Cancel" stays
 * selectable by name), then falls back to a 1-based numeric index. */
export function parseConstraintMatchSelection(
  reply: string,
  options: ConstraintMatchOption[],
): ConstraintMatchOption | 'cancel' | 'invalid' {
  const trimmed = reply.trim();
  const byLabel = options.find(o => o.label.toLowerCase() === trimmed.toLowerCase());
  if (byLabel) return byLabel;
  if (isCancellation(reply)) return 'cancel';
  const byIndex = trimmed.match(/^(\d+)$/);
  if (byIndex) {
    const n = parseInt(byIndex[1], 10);
    if (n >= 1 && n <= options.length) return options[n - 1];
    return 'invalid';
  }
  return 'invalid';
}

/**
 * U4/R11 step 1: extracts a single scoping project key from a filter's (or prior search's) own
 * JQL, so a named fixVersion/sprint constraint can be resolved against that one project's versions
 * or sprints. Deliberately conservative — never guesses:
 * - `project in (...)` is explicit multi-project scoping (or could be a single-element list that
 *   still reads as "not necessarily one project" from the JQL author's intent) — always null.
 * - No `project = ...` clause at all — null.
 * - A quoted (`project = "PROJ"`) or bare (`project = PROJ`) value both match; the key is
 *   upper-cased since Jira project keys are conventionally upper-case but a filter's JQL could have
 *   been typed either way.
 *
 * This is a plain substring/regex scan, not a JQL parser — a project key embedded inside a string
 * literal elsewhere in the JQL (e.g. `summary ~ "project = FOO"`) would be a false positive, but
 * that shape is vanishingly unlikely in a real saved filter and not worth a full JQL grammar here.
 */
export function extractProjectKeyFromJql(jql: string): string | null {
  if (/\bproject\s+in\s*\(/i.test(jql)) return null;
  const match = jql.match(/\bproject\s*=\s*"?([A-Za-z][A-Za-z0-9]*)"?/i);
  return match ? match[1].toUpperCase() : null;
}

/**
 * U7: outcome of `resolveNamedConstraints()` below. `'ambiguous'` carries `resolvedSoFar` (any
 * earlier constraint in the same call that already resolved cleanly) and `remaining` (whichever
 * named constraint(s) still haven't been attempted) so a caller with session memory (the chat
 * flow) can present a pick-list and resume exactly where resolution left off; a caller without
 * session memory (a Language Model tool, R11) instead reports the candidates as plain text and
 * stops — it never guesses and never opens an interactive pick.
 */
export type ConstraintResolutionResult =
  | { kind: 'resolved'; constraints: JqlConstraints }
  | { kind: 'ambiguous'; constraintKind: 'fixVersion' | 'sprint' | 'assignee'; options: ConstraintMatchOption[]; resolvedSoFar: JqlConstraints; remaining: PendingSearchConstraints }
  | { kind: 'notFound'; message: string }
  | { kind: 'noProjectScope'; message: string };

/**
 * U7: extracted from `JiraParticipant.ts`'s `resolveConstraintsAndSearch()` (R3 — one
 * implementation, not two) — resolves any named fixVersion/sprint/assignee constraint against
 * live Jira data via `jiraClient` alone (no `TicketService` needed: `findSprints` is a thin
 * pass-through on `IJiraClient` already). fixVersion and sprint both need a single scoping
 * project key extracted from `baseJql` first; zero matches or no single-project scope is reported
 * without resolving anything; exactly one match resolves that constraint and moves to the next;
 * more than one returns `'ambiguous'` immediately (no guessing, no partial commit to that
 * constraint). `alreadyResolved` carries forward whatever earlier constraint(s) already resolved
 * before a prior ambiguity was hit — the chat flow's resume-after-pick path passes this in;
 * `jira_searchByFilter` (a tool, no session memory) never does.
 */
export async function resolveNamedConstraints(
  baseJql: string,
  named: PendingSearchConstraints,
  jiraClient: IJiraClient,
  alreadyResolved: JqlConstraints = {},
): Promise<ConstraintResolutionResult> {
  const resolved: JqlConstraints = { ...alreadyResolved };

  let projectKey: string | null = null;
  if (named.fixVersion || named.sprint) {
    projectKey = extractProjectKeyFromJql(baseJql);
    if (!projectKey) {
      return {
        kind: 'noProjectScope',
        message:
          `Can't determine a single project from this filter's JQL to resolve the ${named.fixVersion ? 'fix version' : 'sprint'} ` +
          `— it must scope to exactly one project (e.g. \`project = PROJ\`).`,
      };
    }
  }

  if (named.fixVersion) {
    const project = await jiraClient.getProject(projectKey!);
    const needle = named.fixVersion.toLowerCase();
    const matches = (project.versions ?? []).filter(v => v.name.toLowerCase().includes(needle));
    if (matches.length === 0) {
      return { kind: 'notFound', message: `No fix version matching "${named.fixVersion}" found in **${projectKey}**.` };
    } else if (matches.length === 1) {
      resolved.fixVersion = matches[0].name;
    } else {
      const options = matches.map(v => ({ label: v.name, value: v.name }));
      const remaining: PendingSearchConstraints = { sprint: named.sprint, assignee: named.assignee };
      return { kind: 'ambiguous', constraintKind: 'fixVersion', options, resolvedSoFar: resolved, remaining };
    }
  }

  if (named.sprint) {
    const candidates = await jiraClient.findSprints(projectKey!, named.sprint);
    if (candidates.length === 0) {
      return { kind: 'notFound', message: `No sprint matching "${named.sprint}" found in **${projectKey}**.` };
    } else if (candidates.length === 1) {
      resolved.sprint = candidates[0].name;
    } else {
      const options = candidates.map(c => ({ label: `${c.name} (${c.state})`, value: c.name }));
      const remaining: PendingSearchConstraints = { assignee: named.assignee };
      return { kind: 'ambiguous', constraintKind: 'sprint', options, resolvedSoFar: resolved, remaining };
    }
  }

  if (named.assignee) {
    if (['me', 'myself', 'i'].includes(named.assignee.toLowerCase().trim())) {
      resolved.assignee = 'me';
    } else {
      const users = await jiraClient.findUser(named.assignee);
      if (users.length === 0) {
        return { kind: 'notFound', message: `No user found matching "${named.assignee}".` };
      } else if (users.length === 1) {
        const u = users[0];
        resolved.assignee = u.name ?? u.accountId ?? u.displayName;
      } else {
        const options = users.map(u => ({ label: u.displayName, value: u.name ?? u.accountId ?? u.displayName }));
        return { kind: 'ambiguous', constraintKind: 'assignee', options, resolvedSoFar: resolved, remaining: {} };
      }
    }
  }

  return { kind: 'resolved', constraints: resolved };
}

/** R10: the partial-fetch-failure note shared by the chat "show my filters" flow
 * (`handleListMyFilters` in `JiraParticipant.ts`) and this tool-facing formatter, so the two
 * surfaces can't drift on wording. Empty string when both sources succeeded. */
export function buildFilterFailureNote(failedSources: JiraFilterSource[]): string {
  return failedSources.length > 0
    ? `_Could not fetch your ${failedSources.join(' and ')} filter(s) — showing partial results._\n\n`
    : '';
}

/** Renders a `JiraFilter[]` as a "- **name** (id: id)" bullet list, via the shared `formatBulletList`. */
export function formatFilterCandidateList(filters: JiraFilter[]): string {
  return formatBulletList(filters.map(f => `**${f.name}** (id: ${f.id})`));
}

/**
 * U7: `jira_listMyFilters`'s plain-text formatting of `TicketService.getMyFilters()`'s result —
 * mirrors `handleListMyFilters()`'s chat wording (the same failure note, the same "none found"
 * message) so the tool and the chat flow never drift apart (R3), minus the numbered pick-list
 * (a tool has no session memory to resume a pick against — it just lists every filter as text).
 */
export function formatMyFiltersList(filters: JiraFilter[], failedSources: JiraFilterSource[]): string {
  const failureNote = buildFilterFailureNote(failedSources);
  if (filters.length === 0) {
    return `${failureNote}No favourite or owned filters found.`;
  }
  return `${failureNote}Your filters:\n\n${formatFilterCandidateList(filters)}`;
}

/**
 * Plain-text "Jira isn't configured" message naming the specific missing setting or setup
 * command — the same information @jira's chat handler's own not-configured messages give,
 * but without a trusted `MarkdownString` command link (a `LanguageModelToolResult`, unlike a
 * chat stream, can't carry one), so this doubles as both a tool result and plain chat text.
 */
export function buildJiraNotConfiguredMessage(config: Pick<JiraConfig, 'baseUrl' | 'token' | 'authType'>): string {
  if (!config.baseUrl) {
    return (
      'Jira base URL not configured. Add `ticketSidekick.jira.baseUrl` in VS Code settings ' +
      '(e.g. `https://jira.mycompany.com`), then set your credentials.'
    );
  }
  const setupLabel = config.authType === 'cloud'
    ? 'Ticket Sidekick: Configure Jira Cloud Credentials'
    : 'Ticket Sidekick: Set Jira Personal Access Token';
  return `Jira credentials not configured. Run "${setupLabel}" from the Command Palette.`;
}
