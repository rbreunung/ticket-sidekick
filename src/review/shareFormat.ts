import type { BitbucketPR } from '../bitbucket/IBitbucketClient';
import { countFindings, formatReviewForSharing, normalizeShareText, SHARE_SEVERITY_ORDER, type ReviewFinding } from './reviewSessionState';

// The review as text to share: plain text for Teams, which shows pasted Markdown as raw characters,
// and Markdown for places that render it, such as a Bitbucket comment or Confluence. Both are built
// from the stored review, never from what a page sends. Finding, explanation and coverage text is
// untrusted model output: the plain text strips Markdown from it, the Markdown escapes it, so a
// title like "[click](https://x)" or "**urgent**" shows as the characters it is. vscode-free.

export type ShareFormat = 'teams' | 'markdown';

export interface ShareInput {
  pr: Pick<BitbucketPR, 'id' | 'title' | 'author' | 'targetBranch'>;
  url: string;
  findings: ReviewFinding[];
  /** Finding numbers to copy; undefined copies every finding. */
  targets?: number[];
  explanations: Record<number, string>;
  /** The requirements coverage block as plain text, when the review has one. */
  coverageText?: string;
  confidenceThreshold: number;
}

export interface SharedText {
  text: string;
  count: number;
}

/**
 * Model text as plain text: code fences, inline code marks, emphasis, heading marks, block quotes
 * and link syntax are taken out, the words and the code stay. Line breaks are kept.
 */
export function markdownToPlain(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((line) => !/^\s*(```|~~~)/.test(line))
    .map((line) => line
      .replace(/^\s{0,3}#{1,6}\s+/, '')
      .replace(/^\s{0,3}>\s?/, '')
      .replace(/^(\s*)[*+]\s+/, '$1- ')
      .replace(/!?\[([^\]]*)\]\(([^)\s]*)\)/g, (_m, text: string, href: string) => (href ? `${text} (${href})` : text))
      .replace(/`+/g, '')
      .replace(/(\*\*|__)(.+?)\1/g, '$2')
      .replace(/(^|[^\w*])\*(?!\s)([^*\n]+?)\*(?!\w)/g, '$1$2')
      .replace(/(^|[^\w_])_(?!\s)([^_\n]+?)_(?!\w)/g, '$1$2')
      .replace(/[*_]{2,}/g, ''))
    .join('\n');
}

/** Copy for Teams: plain text, with the explanations and the coverage block. */
export function formatShareTeams(input: ShareInput): SharedText {
  const plain = (f: ReviewFinding): ReviewFinding => ({ ...f, title: markdownToPlain(f.title), recommendation: markdownToPlain(f.recommendation) });
  const explanations: Record<number, string> = {};
  for (const [id, text] of Object.entries(input.explanations)) explanations[Number(id)] = markdownToPlain(text);
  const { text, copiedCount } = formatReviewForSharing({
    prId: input.pr.id,
    prTitle: markdownToPlain(input.pr.title),
    prUrl: input.url,
    prAuthor: input.pr.author.displayName,
    prTargetBranch: input.pr.targetBranch,
    findings: input.findings.map(plain),
  }, {
    ...(input.targets ? { targets: input.targets } : {}),
    confidenceThreshold: input.confidenceThreshold,
    ...(input.coverageText ? { coverageText: markdownToPlain(input.coverageText) } : {}),
    coverageWithTargets: true,
    explanations,
  });
  return { text, count: copiedCount };
}

/** Escapes text so Markdown shows it as the characters it is: no emphasis, link, code, heading, table or HTML. */
export function escapeMarkdown(value: string): string {
  return value
    .replace(/[\\`*_[\]#|<>~]/g, (c) => `\\${c}`)
    .replace(/^(\s*)([-=+])/gm, '$1\\$2')
    .replace(/^(\s*\d+)([.)])/gm, '$1\\$2');
}

/** One line of untrusted text, escaped. */
function inline(value: string): string {
  return escapeMarkdown(normalizeShareText(value));
}

/** Untrusted text with its paragraphs kept, each line escaped. */
function paragraphs(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => escapeMarkdown(normalizeShareText(line)))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .split('\n')
    // A hard line break, so a line of the model's text stays its own line.
    .map((line, i, all) => (line && all[i + 1] ? `${line}  ` : line))
    .join('\n');
}

const SEVERITY_LABEL: Record<ReviewFinding['severity'], string> = { critical: 'Critical', warning: 'Warning', suggestion: 'Suggestion' };

/** Copy as Markdown: the same content as the plain text, every untrusted part escaped. */
export function formatShareMarkdown(input: ShareInput): SharedText {
  const selected = input.targets ? input.findings.filter((f) => input.targets!.includes(f.id)) : input.findings;
  const total = input.findings.length;
  const countLabel = input.targets ? `${selected.length} of ${countFindings(total)}` : countFindings(selected.length);
  const by = [`by ${inline(input.pr.author.displayName)}`, input.pr.targetBranch ? ` → ${inline(input.pr.targetBranch)}` : ''].join('');
  const parts: string[] = [
    `**PR #${input.pr.id}: ${inline(input.pr.title)}**  \n${by} · ${countLabel}  \n<${input.url.replace(/[<>\s]/g, '')}>`,
  ];
  if (input.coverageText?.trim()) parts.push(paragraphs(input.coverageText));
  if (selected.length === 0) {
    parts.push('No issues found.');
    return { text: parts.join('\n\n'), count: 0 };
  }
  for (const severity of SHARE_SEVERITY_ORDER) {
    const rows = selected.filter((f) => f.severity === severity);
    if (rows.length === 0) continue;
    parts.push(`**${SEVERITY_LABEL[severity]} (${rows.length})**`);
    for (const f of rows) {
      const file = inline(f.file);
      const location = f.locationUnverified ? `${file} (location unverified)` : `${file}${f.line ? `:L${f.line}` : ''}`;
      const lines = [`**#${f.id}** ${location}: ${inline(f.title)}`, '', `Recommendation: ${inline(f.recommendation)}`];
      if (typeof f.confidence === 'number' && f.confidence < input.confidenceThreshold) lines.push('', '(low confidence)');
      const explanation = input.explanations[f.id];
      if (explanation?.trim()) lines.push('', 'Explanation:', '', paragraphs(explanation));
      parts.push(lines.join('\n'));
    }
  }
  return { text: parts.join('\n\n'), count: selected.length };
}

export function formatShare(format: ShareFormat, input: ShareInput): SharedText {
  return format === 'teams' ? formatShareTeams(input) : formatShareMarkdown(input);
}
