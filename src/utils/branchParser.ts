// Exported so other pure validators (e.g. sessionState.ts's bulk-update toggle-key check) can
// build their own anchored/case-insensitive variant from the same source pattern, rather than
// re-typing the Jira ticket-key shape independently (code-review fix).
export const TICKET_ID_PATTERN = /[A-Z][A-Z0-9]+-\d+/;

export function extractTicketId(branchName: string): string | null {
  const match = branchName.match(TICKET_ID_PATTERN);
  return match ? match[0] : null;
}

/**
 * Key-shaped tokens that are not Jira tickets (`UTF-8`, `SHA-256`, `CVE-2024`, `RFC-7231`, …).
 * Only used where the text is free prose (a PR title or a review prompt), never for branch names.
 */
const NON_JIRA_KEY_PREFIXES = new Set(['UTF', 'SHA', 'ISO', 'RFC', 'CVE', 'CWE', 'GHSA', 'WCAG', 'OWASP', 'ECMA', 'NIST']);

export function isLikelyJiraKey(key: string): boolean {
  return !NON_JIRA_KEY_PREFIXES.has(key.slice(0, key.lastIndexOf('-')));
}

/** The first Jira-looking key in free text with its position, skipping well-known non-ticket shapes. */
export function findJiraKeyMatch(text: string): { key: string; index: number } | undefined {
  const pattern = new RegExp(`(?<![A-Za-z0-9])${TICKET_ID_PATTERN.source}(?![A-Za-z0-9-])`, 'g');
  for (const m of text.matchAll(pattern)) {
    if (isLikelyJiraKey(m[0])) return { key: m[0], index: m.index ?? 0 };
  }
  return undefined;
}

export function findJiraKeyInText(text: string): string | undefined {
  return findJiraKeyMatch(text)?.key;
}
