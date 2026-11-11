import { JiraApiError } from '../utils/apiError';
import { normalizeProjectKey } from './configValidation';

// The check of `ticketSidekick.jira.defaultProject` that runs at start and when the setting
// changes, so a wrong default project shows up at once instead of silently steering a later
// command to the wrong project or to an error. The key's shape is checked first; when Jira is set
// up, Jira is asked whether the project exists. Only a clear "not found" counts as wrong: an
// unreachable Jira or a refused token tells nothing about the setting and gives no warning.

export type DefaultProjectCheck =
  | { kind: 'unset' }
  | { kind: 'ok'; project: string }
  /** The shape was right; Jira was not asked or did not say. */
  | { kind: 'unchecked'; project: string; reason: 'jira-not-configured' | 'jira-error'; status?: number }
  | { kind: 'malformed'; value: string }
  | { kind: 'not-found'; project: string };

export interface DefaultProjectDeps {
  isJiraConfigured(): Promise<boolean>;
  /** Resolves when Jira knows the project; rejects with the Jira error otherwise. */
  getProject(key: string): Promise<unknown>;
}

export async function checkDefaultProject(value: string | undefined, deps: DefaultProjectDeps): Promise<DefaultProjectCheck> {
  const text = (value ?? '').trim();
  if (!text) return { kind: 'unset' };
  const project = normalizeProjectKey(text);
  if (!project) return { kind: 'malformed', value: text };
  if (!(await deps.isJiraConfigured())) return { kind: 'unchecked', project, reason: 'jira-not-configured' };
  try {
    await deps.getProject(project);
    return { kind: 'ok', project };
  } catch (err) {
    if (err instanceof JiraApiError && err.isNotFound) return { kind: 'not-found', project };
    return { kind: 'unchecked', project, reason: 'jira-error', status: err instanceof JiraApiError ? err.status : undefined };
  }
}

/** Shortens a setting value for a message, keeping only printable characters. */
function shown(value: string): string {
  const printable = value.replace(/[\u0000-\u001f\u007f"]/g, '');
  return printable.length > 40 ? `${printable.slice(0, 40)}…` : printable;
}

/** The warning for a wrong default project, or undefined when there is nothing to warn about. */
export function defaultProjectWarning(check: DefaultProjectCheck): string | undefined {
  if (check.kind === 'malformed') {
    return `Ticket Sidekick: the default project "${shown(check.value)}" (ticketSidekick.jira.defaultProject) is not a Jira project key. `
      + 'A key starts with a letter and has only letters, digits and _, for example PROJ.';
  }
  if (check.kind === 'not-found') {
    return `Ticket Sidekick: Jira has no project ${check.project}, the default project in ticketSidekick.jira.defaultProject. `
      + 'Check the key, or that your Jira account can see the project.';
  }
  return undefined;
}
