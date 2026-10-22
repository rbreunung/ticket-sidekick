import { JiraApiError } from './apiError';

/**
 * The names, out of `names`, that Jira refused with a 400 whose body lists them under `errors`
 * (Jira's shape for a field missing from the project's screen is `{"errors":{"duedate":"..."}}`).
 * Keys on the field name, never on the message text, which differs between Data Center and Cloud.
 * Anything else — another status, a non-Jira error, a body that is not that JSON — gives `[]`.
 */
export function refusedFieldsOf(err: unknown, names: readonly string[]): string[] {
  if (!(err instanceof JiraApiError) || err.status !== 400 || !err.body) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(err.body);
  } catch {
    return [];
  }
  const errors = (parsed as { errors?: unknown } | null)?.errors;
  if (!errors || typeof errors !== 'object') return [];
  return names.filter(name => Object.prototype.hasOwnProperty.call(errors, name));
}
