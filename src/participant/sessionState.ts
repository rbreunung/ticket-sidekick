export interface CreationSession {
  template: string;
  project: string;
  summary: string;
  issueType: string;
  allSections: string[];
  pending: string[];
  answers: Record<string, string>;
  fields: Record<string, unknown>;
}

export function extractLastTicketFromText(text: string): string | null {
  const match = text.match(/<!--\s*@jira-ticket:([A-Z][A-Z0-9]+-\d+)\s*-->/);
  return match ? match[1] : null;
}

export function extractCreationSessionFromText(text: string): CreationSession | null {
  const match = text.match(/<!--\s*@jira-create:([\s\S]*?)-->/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]) as CreationSession;
  } catch {
    return null;
  }
}
