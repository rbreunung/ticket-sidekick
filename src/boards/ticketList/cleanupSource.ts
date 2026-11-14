import type { CleanupRule } from '../../templates/TemplateService';
import { findPath, type WorkflowGraph } from '../../services/WorkflowService';
import { quoteJqlValue } from '../../utils/searchConstraints';

// A cleanup rule from `.jira-templates.json` turned into what the ticket list board shows: the
// query for the rule's tickets, the query for their open subtasks, and for every ticket the
// status it moves to and whether a path through the workflow gets it there. No `vscode` here.

/** How a fix version narrows the rule: released or unreleased versions, a `*` pattern, or one version by name. */
export type FixVersionScope =
  | { kind: 'released' }
  | { kind: 'unreleased' }
  | { kind: 'pattern'; pattern: string }
  | { kind: 'exact'; name: string };

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
    case 'pattern': return `fixVersion ~ ${quoteJqlValue(scope.pattern)}`;
    case 'exact': return `fixVersion = ${quoteJqlValue(scope.name)}`;
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
    `project = ${quoteJqlValue(rule.project)}`,
    `issuetype = ${quoteJqlValue(rule.issueType)}`,
    `status != ${quoteJqlValue(rule.targetState)}`,
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
    const keys = parentKeys.slice(i, i + SUBTASK_KEYS_PER_QUERY).map(quoteJqlValue).join(', ');
    queries.push(`parent in (${keys}) AND status != ${quoteJqlValue(subtaskTargetState)} AND resolution is EMPTY`);
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

/** The fields a cleanup rule must have before the board runs it. */
export const REQUIRED_RULE_FIELDS = ['name', 'project', 'issueType', 'targetState'] as const;

/** A rule in `.jira-templates.json` the board will not run, and the fields it lacks. */
export interface RuleProblem {
  /** The rule's name, or its place in the list when it has none ("rule 3"). */
  label: string;
  missing: string[];
}

function filled(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Splits the file's rules into the complete ones and the ones missing a required field. The file
 * is read as written, so an entry can be anything; only a rule with all four fields is run.
 */
export function checkCleanupRules(rules: readonly unknown[]): { rules: CleanupRule[]; problems: RuleProblem[] } {
  const complete: CleanupRule[] = [];
  const problems: RuleProblem[] = [];
  rules.forEach((entry, index) => {
    const rule = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>;
    const missing = REQUIRED_RULE_FIELDS.filter(field => !filled(rule[field]));
    if (missing.length === 0) complete.push(entry as CleanupRule);
    else problems.push({ label: filled(rule.name) ? String(rule.name).trim() : `rule ${index + 1}`, missing: [...missing] });
  });
  return { rules: complete, problems };
}

export function describeRuleProblem(problem: RuleProblem): string {
  return `the cleanup rule "${problem.label}" in .jira-templates.json has no ${problem.missing.join(', ')}, so it cannot run`;
}

export type RuleLookup =
  | { ok: true; rule: CleanupRule; fixVersion?: string }
  | { ok: false; reason: string };

/**
 * Finds the rule a request names. An exact name wins. Otherwise a request of the form
 * `<rule name> in <version>` matches the longest rule name it starts with, and what follows
 * " in " is the fix version, so a rule whose own name contains " in " is still found. A rule
 * that is missing a required field is refused with the field it lacks.
 */
export function lookupCleanupRule(fileRules: readonly unknown[], requested: string, fixVersion?: string): RuleLookup {
  const { rules, problems } = checkCleanupRules(fileRules);
  const wanted = requested.trim().toLowerCase();
  const named = (label: string) => label.trim().toLowerCase();

  const exactProblem = problems.find(p => named(p.label) === wanted);
  const exact = rules.find(rule => named(rule.name) === wanted);
  if (exact) return { ok: true, rule: exact, ...(fixVersion ? { fixVersion } : {}) };
  if (exactProblem) return { ok: false, reason: describeRuleProblem(exactProblem) };

  const candidates = [
    ...rules.map(rule => ({ label: rule.name, rule })),
    ...problems.map(problem => ({ label: problem.label, problem })),
  ]
    .filter(c => wanted.startsWith(`${named(c.label)} in `))
    .sort((a, b) => b.label.trim().length - a.label.trim().length);
  const best = candidates[0];
  if (best) {
    const version = requested.trim().slice(best.label.trim().length + ' in '.length).trim();
    if ('problem' in best && best.problem) return { ok: false, reason: describeRuleProblem(best.problem) };
    if (version && fixVersion && version.toLowerCase() !== fixVersion.trim().toLowerCase()) {
      return { ok: false, reason: `the request names the fix version twice ("${version}" and "${fixVersion}"); give it once.` };
    }
    if (version && 'rule' in best && best.rule) return { ok: true, rule: best.rule, fixVersion: fixVersion || version };
  }

  const known = rules.map(r => `"${r.name}"`).join(', ');
  const broken = problems.length ? ` Not complete, so not run: ${problems.map(p => `"${p.label}" (no ${p.missing.join(', ')})`).join(', ')}.` : '';
  return {
    ok: false,
    reason: `no cleanup rule named "${requested.trim()}" in .jira-templates.json. ${known ? `The rules there are: ${known}.` : fileRules.length === 0 ? 'The file has no cleanupRules.' : 'The file has no complete cleanupRules.'}${broken}`,
  };
}
