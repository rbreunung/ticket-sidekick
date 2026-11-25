import { extractHunkAround, type FileDiff, type ReviewFinding } from '../../review/reviewSessionState';

// The code a finding is about, as the detail pane of the review board shows it: the lines around its
// line from the stored diff of the reviewed commit, each with its line number, and its own line
// marked. Taken from the hunk that holds the line, so it is the code the review saw. vscode-free.

/** How many lines before and after the finding's line the excerpt keeps. */
export const EXCERPT_CONTEXT_LINES = 6;

export interface CodeLine {
  /** The line number: in the new file for added and unchanged lines, in the old file for removed ones. */
  line?: number;
  kind: 'added' | 'context' | 'removed';
  /** The line without its diff marker. */
  text: string;
  /** The finding's own line. */
  marked?: true;
}

export const UNVERIFIED_EXCERPT_NOTE = 'The location could not be verified, so no code is shown.';
export const NO_LINE_EXCERPT_NOTE = 'The finding names no line, so no code is shown.';
export const MISSING_EXCERPT_NOTE = 'The code around this line is not in the stored diff.';

/** The excerpt of one finding, or why there is none. */
export function codeExcerpt(finding: Pick<ReviewFinding, 'line' | 'lineType' | 'locationUnverified'>, fileDiff: FileDiff | undefined): { lines: CodeLine[] } | { note: string } {
  if (finding.locationUnverified) return { note: UNVERIFIED_EXCERPT_NOTE };
  if (!finding.line) return { note: NO_LINE_EXCERPT_NOTE };
  const hunk = fileDiff ? extractHunkAround(fileDiff.diff, finding.line, finding.lineType) : undefined;
  if (!hunk) return { note: MISSING_EXCERPT_NOTE };
  const lines = hunkLines(hunk);
  const removed = finding.lineType === 'REMOVED';
  const at = lines.findIndex(l => l.line === finding.line && (removed ? l.kind === 'removed' : l.kind !== 'removed'));
  if (at === -1) return { note: MISSING_EXCERPT_NOTE };
  lines[at] = { ...lines[at], marked: true };
  return { lines: lines.slice(Math.max(0, at - EXCERPT_CONTEXT_LINES), at + EXCERPT_CONTEXT_LINES + 1) };
}

/** The lines of one numbered hunk (`numberDiffLines` output): `L<n> +code`, `L<n>  code`, `-code`. */
function hunkLines(hunk: string): CodeLine[] {
  const lines: CodeLine[] = [];
  let oldLine = 0;
  let inHunk = false;
  for (const raw of hunk.split('\n')) {
    const header = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(raw);
    if (header) { oldLine = parseInt(header[1], 10); inHunk = true; continue; }
    if (!inHunk || raw.startsWith('\\')) continue;
    const numbered = /^L(\d+) ([+ ])(.*)$/.exec(raw);
    if (numbered) {
      const kind = numbered[2] === '+' ? 'added' : 'context';
      if (kind === 'context') oldLine++;
      lines.push({ line: parseInt(numbered[1], 10), kind, text: numbered[3] });
    } else if (raw.startsWith('-')) {
      lines.push({ line: oldLine++, kind: 'removed', text: raw.slice(1) });
    }
  }
  return lines;
}
