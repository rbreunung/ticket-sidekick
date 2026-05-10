const TICKET_ID_PATTERN = /[A-Z][A-Z0-9]+-\d+/;

export function extractTicketId(branchName: string): string | null {
  const match = branchName.match(TICKET_ID_PATTERN);
  return match ? match[0] : null;
}
