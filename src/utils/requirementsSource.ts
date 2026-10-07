import type { JiraComment, JiraIssue } from '../jira/IJiraClient';
import { formatJiraBody } from './markdownFormatter';

/** Starting size caps for what a review reads from a Jira ticket. Kept together so they can be
 * tuned in one place once real tickets show their shape; deliberately not user settings. */
export const REQUIREMENTS_TEXT_MAX_CHARS = 6000;
export const REQUIREMENTS_COMMENTS_MAX_CHARS = 8000;
export const REQUIREMENTS_COMMENT_MAX_CHARS = 1500;

const TRIMMED_MARKER = ' … [trimmed]';

export interface RequirementsComment {
  author: string;
  /** The raw `created` timestamp from Jira. */
  created: string;
  text: string;
}

/** What the requirements pass reads from a ticket: readable, size-capped, newest comment first. */
export interface RequirementsSource {
  key: string;
  summary: string;
  /** Empty when the ticket has no description. */
  descriptionText: string;
  truncatedDescription: boolean;
  comments: RequirementsComment[];
  /** Older comments left out to stay within the comment budget. */
  omittedComments: number;
  /** The comment fetch failed, so the ticket is shown without its comments. */
  commentsUnavailable: boolean;
}

function trimTo(text: string, max: number): { text: string; trimmed: boolean } {
  return text.length > max ? { text: text.slice(0, max) + TRIMMED_MARKER, trimmed: true } : { text, trimmed: false };
}

/** Newest first by timestamp; Jira lists comments oldest first, so an unreadable timestamp keeps that order reversed. */
function newestFirst(comments: JiraComment[]): JiraComment[] {
  return comments
    .map((comment, index) => ({ comment, index, time: Date.parse(comment.created) }))
    .sort((a, b) => (Number.isNaN(a.time) || Number.isNaN(b.time) ? b.index - a.index : b.time - a.time || b.index - a.index))
    .map((entry) => entry.comment);
}

export function buildRequirementsSource(
  issue: JiraIssue,
  comments: JiraComment[],
  options: { commentsUnavailable?: boolean } = {},
): RequirementsSource {
  const summary = typeof issue.fields.summary === 'string' ? issue.fields.summary : '';
  const description = trimTo(formatJiraBody(issue.fields.description).trim(), Math.max(0, REQUIREMENTS_TEXT_MAX_CHARS - summary.length));

  const kept: RequirementsComment[] = [];
  let used = 0;
  for (const comment of newestFirst(comments)) {
    const text = trimTo(formatJiraBody(comment.body).trim(), REQUIREMENTS_COMMENT_MAX_CHARS).text;
    if (used + text.length > REQUIREMENTS_COMMENTS_MAX_CHARS) break;
    used += text.length;
    kept.push({ author: comment.author?.displayName ?? 'Unknown', created: comment.created, text });
  }

  return {
    key: issue.key,
    summary,
    descriptionText: description.text,
    truncatedDescription: description.trimmed,
    comments: kept,
    omittedComments: comments.length - kept.length,
    commentsUnavailable: options.commentsUnavailable ?? false,
  };
}

/** The ticket as plain text for a prompt or a stored session. */
export function formatRequirementsSourceText(source: RequirementsSource): string {
  const lines = [`Ticket ${source.key}: ${source.summary}`, '', 'Description:', source.descriptionText || '(no description)'];
  if (source.commentsUnavailable) {
    lines.push('', "(The ticket's comments could not be read.)");
  } else if (source.comments.length > 0) {
    lines.push('', 'Comments (newest first):');
    for (const c of source.comments) lines.push(`- ${c.author}, ${c.created.slice(0, 10)}: ${c.text}`);
    if (source.omittedComments > 0) {
      lines.push(`(${source.omittedComments} older comment${source.omittedComments === 1 ? '' : 's'} left out.)`);
    }
  }
  return lines.join('\n');
}
