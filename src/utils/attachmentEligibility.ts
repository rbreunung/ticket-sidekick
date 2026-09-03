import type { JiraAttachment } from '../jira/IJiraClient';

// Which attachments the default load path (`@jira load` / `jira_loadTicket`) downloads
// automatically vs. skips — kept `vscode`-free so the rule itself is Vitest-loadable,
// mirroring `src/utils/reportImport.ts`'s shared-primitives pattern. `jira_downloadAttachment`
// (a targeted, user-named fetch) intentionally does not use `classifyAttachmentEligibility` —
// it bypasses this filter by design (KTD5) — but does reuse `ATTACHMENT_SIZE_LIMIT` as a hard
// safety cap.

export const DOWNLOADABLE_EXTENSIONS = new Set([
  // text / source
  '.log', '.txt', '.java', '.xml', '.json', '.yaml', '.yml', '.md',
  '.properties', '.sql', '.sh', '.py', '.js', '.ts', '.html', '.css',
  '.patch', '.diff',
  // documents
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.odt', '.ods', '.odp', '.rtf', '.csv',
  // archives
  '.zip', '.tar', '.gz', '.tgz', '.bz2', '.7z', '.rar', '.jar', '.war', '.ear',
]);
export const ATTACHMENT_SIZE_LIMIT = 100 * 1024 * 1024;

/** Sorts a ticket's attachments into what the default load path downloads automatically
 * vs. skips: oversized files (over `ATTACHMENT_SIZE_LIMIT`) are skipped regardless of type;
 * otherwise text/image MIME types and known extensions (`DOWNLOADABLE_EXTENSIONS`) download,
 * everything else is skipped as unknown binary. */
export function classifyAttachmentEligibility(
  attachments: JiraAttachment[],
): { toDownload: JiraAttachment[]; toSkip: JiraAttachment[] } {
  const toDownload: JiraAttachment[] = [];
  const toSkip: JiraAttachment[] = [];
  for (const att of attachments) {
    if (att.size > ATTACHMENT_SIZE_LIMIT) { toSkip.push(att); continue; }
    const ext = att.filename.includes('.') ? ('.' + att.filename.split('.').pop()!.toLowerCase()) : '';
    const eligible = att.mimeType.startsWith('text/') || att.mimeType.startsWith('image/') || DOWNLOADABLE_EXTENSIONS.has(ext);
    (eligible ? toDownload : toSkip).push(att);
  }
  return { toDownload, toSkip };
}

/** Finds the attachment matching `filename` exactly, for `jira_downloadAttachment` (R9/R10).
 * Jira does not enforce attachment-filename uniqueness per issue, so more than one attachment
 * can share a name (e.g. a log re-uploaded after a fix attempt); when that happens the one
 * with the latest `created` timestamp wins, mirroring how the Jira web UI itself resolves a
 * same-named attachment (KTD5/KTD7). Returns `matchCount` alongside the winner (or `undefined`
 * when nothing matches) in one pass, since callers need both. */
export function findAttachmentByFilename(
  attachments: JiraAttachment[],
  filename: string,
): { attachment: JiraAttachment | undefined; matchCount: number } {
  const matches = attachments.filter((a) => a.filename === filename);
  const attachment = matches.length === 0
    ? undefined
    : matches.reduce((latest, current) => (current.created > latest.created ? current : latest));
  return { attachment, matchCount: matches.length };
}

/** Resolves same-filename duplicates within a set of attachments the default load path is
 * about to download — the same "latest `created` wins" rule {@link findAttachmentByFilename}
 * applies for `jira_downloadAttachment`, but here it matters because `loadTicketToWorkspace`
 * downloads its `toDownload` set concurrently: two attachments sharing a filename would race
 * to write the same `attachments/<name>` path with no error and no indication a file was
 * silently dropped. `duplicates` (every losing attachment) is meant to be folded into the
 * skipped-attachments list instead of written. */
export function dedupeByLatestFilename(
  attachments: JiraAttachment[],
): { unique: JiraAttachment[]; duplicates: JiraAttachment[] } {
  const byFilename = new Map<string, JiraAttachment[]>();
  for (const att of attachments) {
    const group = byFilename.get(att.filename);
    if (group) group.push(att); else byFilename.set(att.filename, [att]);
  }
  const unique: JiraAttachment[] = [];
  const duplicates: JiraAttachment[] = [];
  for (const group of byFilename.values()) {
    if (group.length === 1) { unique.push(group[0]); continue; }
    const winner = group.reduce((latest, current) => (current.created > latest.created ? current : latest));
    unique.push(winner);
    duplicates.push(...group.filter(a => a !== winner));
  }
  return { unique, duplicates };
}

/** Renders a byte count as `"1.2 MB"` or `"46 KB"` — shared by `ticket.md`'s attachment list,
 * the skipped-attachments summary, and `jira_downloadAttachment`'s size-cap rejection message. */
export function formatFileSize(bytes: number): string {
  return bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}
