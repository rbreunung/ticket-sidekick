// Leaf chat helpers: markdown neutralizing, confirm/cancel and greeting words, the review-table renderer and counted nouns. Pure (vscode-free).

export function isConfirmation(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  const CONFIRMATIONS = new Set([
    'yes', 'yep', 'ok', 'okay', 'sure', 'perfect', 'great',
    'looks good', 'looks great', 'go ahead', 'do it', 'ship it',
    'post it', 'post', 'confirm', 'confirmed', 'submit', 'approved', 'approve', 'fine',
    'load all', 'load more', 'show all', 'show more', 'create it',
  ]);
  return CONFIRMATIONS.has(normalized);
}

export function isCancellation(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  const CANCELLATIONS = new Set([
    'c', 'no', 'nope', 'cancel', 'cancelled', 'stop', 'abort',
    'never mind', 'nevermind', "don't", 'dont', 'quit', 'skip',
  ]);
  return CANCELLATIONS.has(normalized);
}

/**
 * Neutralizes markdown link/image syntax in untrusted, externally-influenced text (a Jira ticket
 * summary, custom field value, an imported item's subject/title, …) before it is combined into the
 * same string as one or more real command links and the whole thing is trust-gated
 * (`trustedChatMarkdown()`, `src/utils/chatMarkdown.ts`). Without this, a crafted `[label](command:workbench.action.chat.open?…)`
 * sequence hiding inside that untrusted text would render as a live, clickable command once the
 * response is trusted — silently resubmitting an attacker-chosen message as the user's own next
 * chat turn. Replaces `[`/`]` with visually similar full-width brackets rather than stripping them,
 * so the text stays readable and no other markdown-significant character is touched — unlike
 * `sanitizeCellText()` (`reportImport.ts`), which also strips wiki-markup trigger characters for a
 * different destination (Jira wiki markup, not this extension's own trusted chat responses).
 */
export function neutralizeMarkdownLinks(value: string): string {
  return value.replace(/\[/g, '［').replace(/\]/g, '］');
}

export interface ReviewTableColumn<TRow> {
  header: string;
  accessor: (row: TRow) => string;
}

/**
 * Renders one markdown table — header row, a standardized dash separator row, and one data row
 * per input row — from a column descriptor list and a flat row list.
 *
 * Presentation-only: it has no opinion on sanitization, truncation, row grouping/sections, skip
 * vs. toggle reply semantics, or session expiry — those all stay caller concerns. A multi-section
 * screen (e.g. "already ticketed" vs. "new") is composed by the caller invoking this once per
 * section — passing that section's own column array, which may include section-specific extra
 * columns (e.g. a "Ticket" column) — and prepending its own section heading before each call's
 * output. Holds no state between calls.
 */
export function renderReviewTable<TRow>(columns: ReviewTableColumn<TRow>[], rows: TRow[]): string {
  const headerRow = `| ${columns.map(c => c.header).join(' | ')} |`;
  const separatorRow = `| ${columns.map(() => '---').join(' | ')} |`;
  const dataRows = rows.map(row => `| ${columns.map(c => c.accessor(row)).join(' | ')} |`);
  return [headerRow, separatorRow, ...dataRows].join('\n');
}

function pluralNoun(itemNoun: string): string {
  return itemNoun.replace('(s)', 's'); // 'component(s)' -> 'components'
}

export function countedNoun(count: number, itemNoun: string): string {
  return `${count} ${count === 1 ? itemNoun.replace('(s)', '') : pluralNoun(itemNoun)}`;
}


/** Renders `items` as a `- ` bulleted list, one per line — shared by every result message
 * below that lists plain strings or pre-formatted per-item text. Exported so `jiraTools.ts`'s
 * ambiguous-match text results use the same shape instead of a second hand-rolled join. */
export function formatBulletList(items: string[]): string {
  return items.map(item => `- ${item}`).join('\n');
}

/**
 * Exact-match (not substring/word-list) detection of an empty invocation or an obvious
 * greeting/help-shaped prompt — mirrors `isConfirmation()`/`isCancellation()`'s own
 * whole-normalized-string `Set` membership above, for the same reason: a substring or
 * per-word test on "hi" would misfire on legitimate operation text like "update HI-1
 * status", but an exact-string `Set` membership check never can, since the normalized whole
 * prompt "update hi-1 status" is never equal to "hi". See the specific-before-generic ordering
 * principle in
 * docs/solutions/logic-errors/confirm-cancel-word-list-broadening-swallows-domain-name-collisions.md
 * — this function sidesteps that hazard entirely by never doing substring matching in the first
 * place, rather than needing a live-domain-value check ordered ahead of it.
 */
const GREETING_OR_HELP_PHRASES = new Set<string>([
  '', 'hi', 'hello', 'hey', 'hiya', 'yo', 'howdy',
  'help', 'help me', '?', "what's up", 'whats up',
  'what can you do', 'what do you do', 'what can you help with', 'what can you help me with',
  'how does this work', 'how do i use this', 'how do i use you',
  'getting started', 'get started', 'what is this', 'who are you',
]);

export function isGreetingOrEmpty(prompt: string): boolean {
  const normalized = prompt.trim().toLowerCase().replace(/[!?.]+$/g, '').replace(/\s+/g, ' ').trim();
  return GREETING_OR_HELP_PHRASES.has(normalized);
}
