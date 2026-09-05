// Exported so other pure validators (e.g. sessionState.ts's bulk-update toggle-key check) can
// build their own anchored/case-insensitive variant from the same source pattern, rather than
// re-typing the Jira ticket-key shape independently (code-review fix).
export const TICKET_ID_PATTERN = /[A-Z][A-Z0-9]+-\d+/;

export function extractTicketId(branchName: string): string | null {
  const match = branchName.match(TICKET_ID_PATTERN);
  return match ? match[0] : null;
}
