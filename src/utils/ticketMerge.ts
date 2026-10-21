// Waltz ticket merge: pure helpers (vscode-free) — the text a cancelled ticket is marked with. The reference
// resolution, step plan and refresh rule join this file in the merge flow's own units.
import { MAX_SUMMARY_CHARS, clampSummary } from './reportImport';

const MERGED_PREFIX = /^\[Merged into [A-Z][A-Z0-9]+-\d+\] /;
const BANNER = /^\{panel:title=Merged into [A-Z][A-Z0-9]+-\d+\}[\s\S]*?\{panel\}\n*/;

/** `[Merged into KEY] <old summary>`, within the 255-character limit by trimming only the old summary; an earlier marker is replaced. */
export function mergedSummary(summary: string, survivorKey: string): string {
  const prefix = `[Merged into ${survivorKey}] `;
  const base = summary.replace(MERGED_PREFIX, '');
  return prefix + clampSummary(base, '', MAX_SUMMARY_CHARS - prefix.length);
}

/** The banner (Jira wiki) above the body of a cancelled ticket; the body stays as it was, and an earlier banner is replaced. */
export function mergedBanner(description: string | null | undefined, survivorKey: string): string {
  const banner = `{panel:title=Merged into ${survivorKey}}\nThis ticket was merged into ${survivorKey} and closed as a duplicate. Its items are tracked there.\n{panel}`;
  const body = (description ?? '').replace(BANNER, '');
  return body === '' ? banner : `${banner}\n\n${body}`;
}
