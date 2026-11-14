/**
 * Pure config validators (no `vscode` dependency) so misconfiguration is caught with a
 * clear message — surfaced via `/ts-jira check` / `@bitbucket check` — instead of an opaque
 * 404/HTML error at request time.
 */

/**
 * Validate a configured base URL. Returns an error message, or `null` when the URL is
 * absent (presence is enforced separately) or well-formed `http(s)`.
 */
export function validateBaseUrl(url: string | undefined): string | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `Base URL "${url}" is not a valid URL. Use a full URL like https://jira.mycompany.com.`;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `Base URL "${url}" must start with http:// or https:// (got "${parsed.protocol}").`;
  }
  if (!parsed.hostname) {
    return `Base URL "${url}" is missing a host. Use a full URL like https://jira.mycompany.com.`;
  }
  return null;
}

/** What a Jira project key looks like: a letter, then letters, digits or `_`, compared in upper case. */
export const PROJECT_KEY_PATTERN = /^[A-Z][A-Z0-9_]{0,49}$/;

/** The project key in upper case, or undefined when the text is not a project key. */
export function normalizeProjectKey(text: string): string | undefined {
  const key = text.trim().toUpperCase();
  return PROJECT_KEY_PATTERN.test(key) ? key : undefined;
}
