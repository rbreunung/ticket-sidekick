import type { ReviewBackground } from '../services/PrReviewService';

/**
 * A background ticket as the first lines inside the untrusted fence of a review prompt, ending in
 * a separator line and an empty line; none for own text, no background or an empty ticket text.
 * The one builder every review prompt uses, so each fences the ticket the same way. vscode-free.
 */
export function ticketBackgroundLines(background: ReviewBackground | undefined): string[] {
  if (background?.kind !== 'ticket' || !background.text.trim()) return [];
  return [`Background ticket ${background.key} (what the change is meant to do):`, background.text.trim(), '', '---', ''];
}
