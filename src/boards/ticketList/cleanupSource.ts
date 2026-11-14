import type { CleanupRule } from '../../templates/TemplateService';
import { findPath, type WorkflowGraph } from '../../services/WorkflowService';

// A cleanup rule from `.jira-templates.json` turned into what the ticket list board shows: the
// query for the rule's tickets, the query for their open subtasks, and for every ticket the
// status it moves to and whether a path through the workflow gets it there. No `vscode` here.

/** Statuses that close a ticket, so a resolution is asked for when the rule names none. */
export const CLOSED_LIKE_STATUSES = new Set(['done', 'resolved', 'closed', "won't fix", 'wont fix', 'rejected', 'cancelled', 'canceled']);

export function isClosedLike(status: string): boolean {
  return CLOSED_LIKE_STATUSES.has(status.trim().toLowerCase());
}

/** How a fix version narrows the rule: released or unreleased versions, a `*` pattern, or one version by name. */
export type FixVersionScope =
  | { kind: 'released' }
  | { kind: 'unreleased' }
  | { kind: 'pattern'; pattern: string }
  | { kind: 'exact'; name: string };

function quoteJql(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * The fix version a request gives, as the rule's own fields would: `released` and `unreleased`
 * mean Jira's version functions, a value with `*` is a pattern, and a value in double quotes is
 * always one version by that name, so a version named "released" can still be asked for.
 */
export function parseFixVersionOverride(value: string): FixVersionScope | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const quoted = trimmed.match(/^"(.+)"$/);
  if (quoted) return { kind: 'exact', name: quoted[1] };
  const lower = trimmed.toLowerCase();
  if (lower === 'released') return { kind: 'released' };
  if (lower === 'unreleased') return { kind: 'unreleased' };
  if (trimmed.includes('*')) return { kind: 'pattern', pattern: trimmed };
  return { kind: 'exact', name: trimmed };
}

function ruleFixVersion(rule: CleanupRule): FixVersionScope | undefined {
  if (rule.fixVersionFilter === 'released') return { kind: 'released' };
  if (rule.fixVersionFilter === 'unreleased') return { kind: 'unreleased' };
  if (rule.fixVersionPattern) return { kind: 'pattern', pattern: rule.fixVersionPattern };
  return undefined;
}

function fixVersionClause(scope: FixVersionScope): string {
  switch (scope.kind) {
    case 'released': return 'fixVersion in releasedVersions()';
    case 'unreleased': return 'fixVersion in unreleasedVersions()';
    case 'pattern': return `fixVersion ~ ${quoteJql(scope.pattern)}`;
    case 'exact': return `fixVersion = ${quoteJql(scope.name)}`;
  }
}

export function describeFixVersion(scope: FixVersionScope | undefined): string | undefined {
  if (!scope) return undefined;
  switch (scope.kind) {
    case 'released': return 'released versions';
    case 'unreleased': return 'unreleased versions';
    case 'pattern': return `fix version ~ "${scope.pattern}"`;
    case 'exact': return `fix version "${scope.name}"`;
  }
}

export interface CleanupQuery {
  jql: string;
  /** Said on the board, e.g. that the rule's extra JQL was left out. */
  warnings: string[];
  fixVersion?: FixVersionScope;
}

/**
 * The rule's query: project, issue type, not yet in the target status and unresolved, always;
 * then the fix version (a request's override wins over the rule) and the rule's extra JQL.
 */
export function buildCleanupQuery(rule: CleanupRule, override?: string): CleanupQuery {
  const warnings: string[] = [];
  const fixVersion = (override !== undefined ? parseFixVersionOverride(override) : undefined) ?? ruleFixVersion(rule);
  const parts = [
    `project = ${quoteJql(rule.project)}`,
    `issuetype = ${quoteJql(rule.issueType)}`,
    `status != ${quoteJql(rule.targetState)}`,
    'resolution is EMPTY',
  ];
  if (fixVersion) parts.push(fixVersionClause(fixVersion));
  const extra = rule.jql?.trim();
  if (extra) {
    if (/\bORDER\s+BY\b/i.test(extra)) warnings.push('The rule\'s extra JQL contains ORDER BY, which is not allowed there; it was left out.');
    else parts.push(`(${extra})`);
  }
  return { jql: parts.join(' AND '), warnings, ...(fixVersion ? { fixVersion } : {}) };
}

export const SUBTASK_KEYS_PER_QUERY = 100;

/** The queries for the open subtasks of the given parents, a hundred parents per query. */
export function buildSubtaskQueries(parentKeys: string[], subtaskTargetState: string): string[] {
  const queries: string[] = [];
  for (let i = 0; i < parentKeys.length; i += SUBTASK_KEYS_PER_QUERY) {
    const keys = parentKeys.slice(i, i + SUBTASK_KEYS_PER_QUERY).map(quoteJql).join(', ');
    queries.push(`parent in (${keys}) AND status != ${quoteJql(subtaskTargetState)} AND resolution is EMPTY`);
  }
  return queries;
}

/** The status a parent and its subtasks move to, and the resolution each gets. */
export interface CleanupTargets {
  targetState: string;
  subtaskTargetState: string;
  resolution?: string;
  subtaskResolution?: string;
}

export function cleanupTargets(rule: CleanupRule): CleanupTargets {
  return {
    targetState: rule.targetState,
    subtaskTargetState: rule.subtaskTargetState ?? rule.targetState,
    ...(rule.resolution ? { resolution: rule.resolution } : {}),
    ...(rule.subtaskResolution ?? rule.resolution ? { subtaskResolution: rule.subtaskResolution ?? rule.resolution } : {}),
  };
}

/**
 * Why a ticket cannot be moved to `target`, or undefined when the workflow has a path. A missing
 * workflow graph is a reason too: nothing is moved along a path nobody has seen.
 */
export function pathProblem(graph: WorkflowGraph | undefined, from: string, target: string): string | undefined {
  if (!graph || Object.keys(graph).length === 0) return `the workflow could not be read, so no path to ${target} is known`;
  if (from.toLowerCase() === target.toLowerCase()) return undefined;
  return findPath(graph, from, target) === null ? `no path from ${from} to ${target}` : undefined;
}
