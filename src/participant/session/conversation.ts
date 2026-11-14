// History serialization, the free-text reply of an ask, and the email template/issue-type pick.
// Pure (vscode-free); re-exported through ../sessionState.ts.

export { formatCommentsInFull, rewriteAttachmentLinks } from '../../utils/ticketText';

// Defensive sanitizer over LLM history text (llmHelpers.ts): no code path emits HTML-comment
// markers anymore since the R13 metadata migration, but history turns from pre-migration
// versions may still carry them — strip before that text is fed back into an LLM prompt.
export function stripHiddenMarkers(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, '').replace(/\s+/g, ' ').trim();
}

const MAX_HISTORY_CHARS = 30_000;

export function serializeTurns(
  turns: Array<{ role: 'user' | 'assistant'; text: string }>,
  mode: 'recent' | 'full',
): string {
  const selected = mode === 'recent' ? turns.slice(-10) : turns;
  const serialized = selected
    .filter((t) => t.text.length > 0)
    .map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.text}`)
    .join('\n\n');
  if (serialized.length <= MAX_HISTORY_CHARS) return serialized;
  const tail = serialized.slice(-MAX_HISTORY_CHARS);
  const turnBoundary = /\n\n(User|Assistant): /.exec(tail);
  const clean = turnBoundary ? tail.slice(turnBoundary.index + 2) : tail;
  return `_(oldest turns omitted to fit context)_\n\n${clean}`;
}

/** Unlike isCancellation()'s broad word list (which treats a literal "stop" as cancellation), the
 * shared issue-type ask recognizes only an explicit "(c)" reply as cancellation, checked before any
 * other interpretation — so an issue type genuinely named "Stop" stays enterable there. */
export function isExplicitCancelToken(reply: string): boolean {
  return reply.trim().toLowerCase() === '(c)';
}

export type AwaitFreeTextReply =
  | { action: 'cancel' }
  | { action: 'empty' }
  | { action: 'value'; value: string };

/** Parser for a free-text chat ask that needs "a non-empty string, or cancel/re-prompt", such as a
 * typed issue type. Cancellation uses isExplicitCancelToken(), not isCancellation(). */
export function parseAwaitFreeTextReply(reply: string): AwaitFreeTextReply {
  if (isExplicitCancelToken(reply)) return { action: 'cancel' };
  const trimmed = reply.trim();
  if (trimmed.length === 0) return { action: 'empty' };
  return { action: 'value', value: trimmed };
}


export type EmailOptionPick =
  | { kind: 'template'; name: string; issueType: string }
  | { kind: 'type'; issueType: string };

export function pickEmailOption(
  n: number,
  templates: Array<{ name: string; issueType: string }>,
  issueTypes: string[],
): EmailOptionPick | null {
  if (n < 1 || n > templates.length + issueTypes.length) return null;
  if (n <= templates.length) {
    const t = templates[n - 1];
    return { kind: 'template', name: t.name, issueType: t.issueType };
  }
  return { kind: 'type', issueType: issueTypes[n - templates.length - 1] };
}



