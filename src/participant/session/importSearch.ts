// Report-import ticket search: the `search <keyword>` reply lists the open tickets the review already matched whose
// summary contains the keyword. Pure (vscode-free); no Jira call is made here.

import { formatKeyLink } from '../../services/TicketService';
import { IMPORT_COMMANDS, SEARCH_USAGE } from './importScreens';
import { safeMarkdownText } from './importReplies';
import type { TicketSearchOutcome } from '../../imports/rows';

// The search match moved to src/imports/rows.ts, which the import board shares; this file keeps its chat wording.
export { findTicketsBySummary, SEARCH_RESULT_LIMIT, type TicketSearchOutcome, type TicketSearchResult } from '../../imports/rows';

/** The chat text for a search outcome. Summaries and statuses are untrusted Jira text on a trusted screen: `safeMarkdownText` defuses links, autolinks and line breaks. */
export function buildSearchResults(outcome: TicketSearchOutcome, keyword: string, baseUrl?: string): string {
  if (outcome.kind === 'usage') return SEARCH_USAGE;
  if (outcome.kind === 'no-info') {
    return `_This review holds no ticket summaries to search (it was saved by an older version). Reply \`${IMPORT_COMMANDS.reload}\` to read them again._`;
  }
  const shown = safeMarkdownText(keyword.trim());
  if (outcome.results.length === 0) return `No open tickets in this review have a summary containing “${shown}”.`;
  const lines = outcome.results.map(r => {
    const ids = r.ids.length > 0 ? `${r.ids.join(', ')} · ` : '';
    const status = r.status ? ` · ${safeMarkdownText(r.status)}` : '';
    return `- ${ids}${formatKeyLink(r.key, baseUrl)}${status} · ${safeMarkdownText(r.summary)}`;
  });
  const more = outcome.total > outcome.results.length ? `\n\n_${outcome.total - outcome.results.length} more match — narrow the keyword to see them._` : '';
  const plural = outcome.total === 1 ? 'ticket' : 'tickets';
  return `**${outcome.total} open ${plural} with a summary containing “${shown}”:**\n\n${lines.join('\n')}${more}`;
}
