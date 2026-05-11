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

export function stripHiddenMarkers(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, '').replace(/\s+/g, ' ').trim();
}

export function serializeTurns(
  turns: Array<{ role: 'user' | 'assistant'; text: string }>,
  mode: 'recent' | 'full',
): string {
  const selected = mode === 'recent' ? turns.slice(-3) : turns;
  return selected
    .filter((t) => t.text.length > 0)
    .map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.text}`)
    .join('\n\n');
}

export function extractCreatedKeyFromConfirmation(confirmation: string): string | null {
  const m = confirmation.match(/([A-Z][A-Z0-9]+-\d+)/);
  return m ? m[1] : null;
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

export interface ContentSession {
  ticketKey: string;
  operation: 'addComment' | 'updateDescription';
  currentContent: string;
  historyContext: string | undefined;
}

export function isConfirmation(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  const CONFIRMATIONS = new Set([
    'yes', 'yep', 'ok', 'okay', 'sure', 'perfect', 'great',
    'looks good', 'looks great', 'go ahead', 'do it', 'ship it',
    'post it', 'confirm', 'confirmed', 'submit', 'approved', 'approve', 'fine',
    'load all', 'load more', 'show all', 'show more',
  ]);
  return CONFIRMATIONS.has(normalized);
}

export function isCancellation(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  const CANCELLATIONS = new Set([
    'no', 'nope', 'cancel', 'cancelled', 'stop', 'abort',
    'never mind', 'nevermind', "don't", 'dont', 'quit', 'skip',
  ]);
  return CANCELLATIONS.has(normalized);
}

export interface MoreCommentsSession {
  ticketKey: string;
  commentQuery: string | null;
  total: number;
}

export function extractMoreCommentsSessionFromText(text: string): MoreCommentsSession | null {
  const match = text.match(/<!--\s*@jira-more-comments:([\s\S]*?)-->/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]) as MoreCommentsSession;
  } catch {
    return null;
  }
}

export function extractContentSessionFromText(text: string): ContentSession | null {
  const match = text.match(/<!--\s*@jira-content:([\s\S]*?)-->/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]) as ContentSession;
  } catch {
    return null;
  }
}
