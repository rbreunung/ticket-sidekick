// The email importer: the descriptor the shared import flow runs on for a batch of `.eml` files,
// the description and comment wiki an email becomes, and the batch caps checked before any file is
// read. vscode-free: the settings are passed in as readers.
import * as fs from 'fs';
import * as path from 'path';
import type { DiagLogger } from '../utils/diagTypes';
import type { EmailImportItem, EmailReviewRow } from '../utils/emlParser';
import { markdownToJiraWiki } from '../utils/markdownToJiraWiki';
import { BATCH_LIMIT, sanitizeCellText } from '../utils/reportImport';
import type { ReviewTableColumn } from '../utils/chatPrimitives';
import type { ReportImportDescriptor } from './descriptor';

/** The email settings, read each time they are needed. */
export interface EmailSettings {
  /** `ticketSidekick.email.deleteEmlAfterImport`. */
  deleteEmlAfterImport: () => boolean;
  /** `ticketSidekick.email.maxBatchSizeMB` as a byte limit. */
  maxBatchBytes: () => number;
}

/**
 * Converts an email's Markdown body to Jira wiki markup with inline-image placeholders resolved. The
 * captured file name comes from the email and is put into Jira's image syntax outside
 * markdownToJiraWiki(), so only the captured value is sanitized (the `!name|thumbnail!` delimiters
 * must survive).
 */
export function buildEmailJiraWiki(markdownBody: string): string {
  let jiraWiki = markdownToJiraWiki(markdownBody);
  jiraWiki = jiraWiki.replace(/\n{3,}/g, '\n\n');
  return jiraWiki.replace(/\[📎 ([^\]]+)\]/g, (_match, name: string) => `!${sanitizeCellText(name)}|thumbnail!`);
}

/**
 * The From/Date header of an email added as a comment. The sender's display name comes from the
 * email and goes into live wiki markup, so the value alone is sanitized (the `*` bold markers must
 * survive).
 */
export function buildEmailCommentHeader(senderName?: string, receivedDateTime?: string): string {
  const parts: string[] = [];
  if (senderName) parts.push(`*From:* ${sanitizeCellText(senderName)}`);
  if (receivedDateTime) parts.push(`*Date:* ${receivedDateTime.slice(0, 10)}`);
  return parts.length > 0 ? parts.join('  ·  ') + '\n\n' : '';
}

/** The comment an email becomes on an existing ticket: the header, then the body. */
export function buildEmailCommentWiki(email: Pick<EmailImportItem, 'senderName' | 'receivedDateTime' | 'markdownBody'>): string {
  return `${buildEmailCommentHeader(email.senderName, email.receivedDateTime)}${buildEmailJiraWiki(email.markdownBody)}`;
}

/**
 * Checks the file-count cap and the total-size cap for a selection of `.eml` files before any file
 * is read. Returns the message to show, or null when both caps hold. A file whose size cannot be
 * read counts as empty here; reading it fails properly later.
 */
export async function checkEmailBatchCaps(filePaths: string[], maxBatchBytes: number): Promise<string | null> {
  if (filePaths.length > BATCH_LIMIT) {
    return `Selected ${filePaths.length} files — the batch limit is ${BATCH_LIMIT}. Select ${BATCH_LIMIT} or fewer and try again.`;
  }
  const sizes = await Promise.all(filePaths.map(p => fs.promises.stat(p).then(stat => stat.size).catch(() => 0)));
  const totalBytes = sizes.reduce((sum, size) => sum + size, 0);
  if (totalBytes > maxBatchBytes) {
    const totalMb = (totalBytes / (1024 * 1024)).toFixed(1);
    const capMb = maxBatchBytes / (1024 * 1024);
    return `Selected files total ${totalMb} MB — the batch limit is ${capMb} MB. Select fewer or smaller files and try again.`;
  }
  return null;
}

/** Uploads every attachment of an email to a ticket; the names and reasons of the ones that failed. */
export async function uploadEmailAttachments(
  attachments: EmailImportItem['attachments'],
  issueKey: string,
  upload: (name: string, contentType: string, contentBytes: string) => Promise<unknown>,
  onDiag?: DiagLogger,
): Promise<{ uploaded: number; failures: string[] }> {
  let uploaded = 0;
  const failures: string[] = [];
  await Promise.all(attachments.map(att =>
    upload(att.name, att.contentType, att.contentBytes)
      .then(() => { uploaded++; })
      .catch(err => {
        const message = err instanceof Error ? err.message : String(err);
        onDiag?.('warn', `Attachment upload failed — ${att.name}`, { issueKey, fileName: att.name, error: message });
        failures.push(`${att.name}: ${message}`);
      }),
  ));
  return { uploaded, failures };
}

// Subject and attachment names come from the email; the chat table neutralizes them where it renders.
function emailReviewColumns(neutralize: (text: string) => string): ReviewTableColumn<EmailReviewRow>[] {
  return [
    { header: 'Subject', accessor: row => neutralize(row.subject) },
    { header: 'Attachments', accessor: row => (row.attachmentNames.length > 0 ? neutralize(row.attachmentNames.join(', ')) : '—') },
  ];
}

export const EMAIL_TEMPLATE_SESSION_KEY = 'jira.session.emailTemplateSelection';
export const EMAIL_REVIEW_SESSION_KEY = 'jira.session.emailReview';

/**
 * The email descriptor. Email has no dedup key, so the already-ticketed search is skipped; the
 * attachments are uploaded after creation and the `.eml` deleted when the setting says so. A failed
 * upload throws after the ticket exists, which the shared creation step shows as a warning.
 */
export function createEmailDescriptor(
  settings: EmailSettings,
  options: { onDiag?: DiagLogger; neutralize?: (text: string) => string } = {},
): ReportImportDescriptor<EmailImportItem, EmailReviewRow> {
  const { onDiag } = options;
  return {
    descriptorKind: 'email',
    scope: 'jira.email',
    importLabel: 'Email',
    itemNoun: 'email(s)',
    filterKindLabel: 'selection',
    noMatchMessage: '_No emails were selected._',
    sessionKeys: { templateSelection: EMAIL_TEMPLATE_SESSION_KEY, review: EMAIL_REVIEW_SESSION_KEY },
    buildRowFields: item => ({
      subject: item.subject,
      senderName: item.senderName,
      ...(item.receivedDateTime ? { receivedDateTime: item.receivedDateTime } : {}),
      attachmentNames: item.attachments.filter(a => !a.isInline).map(a => a.name),
      markdownBody: item.markdownBody,
      inlineImageMap: item.inlineImageMap,
      attachments: item.attachments,
      emlFilePath: item.emlFilePath,
    }),
    reviewColumns: emailReviewColumns(options.neutralize ?? (text => text)),
    itemRefFor: row => row.subject,
    buildTicketFields: (row, additionalFields) => ({
      summary: row.subject,
      fields: { ...additionalFields, description: buildEmailJiraWiki(row.markdownBody) },
    }),
    afterCreate: async (row, issueKey, ticketService) => {
      const { uploaded, failures } = await uploadEmailAttachments(
        row.attachments, issueKey, (name, type, bytes) => ticketService.uploadAttachment(issueKey, name, type, bytes), onDiag,
      );
      if (failures.length > 0) {
        // The file stays, even with deleteEmlAfterImport on: it is the only copy of the attachments that did not upload.
        const kept = settings.deleteEmlAfterImport() ? ' The .eml file was kept.' : '';
        throw new Error(`Uploaded ${uploaded} of ${row.attachments.length} attachment(s); failed: ${failures.join('; ')}.${kept}`);
      }
      if (settings.deleteEmlAfterImport()) {
        await fs.promises.unlink(row.emlFilePath).catch((err: unknown) => {
          onDiag?.('warn', `Could not delete .eml after import — ${path.basename(row.emlFilePath)}`, {
            emlFilePath: row.emlFilePath, error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    },
  };
}

// ── Likely repeats: an email whose subject is already a ticket's summary ──────────────────────────

/** Reply and forward prefixes a mail client puts before a subject, in English and German. */
const SUBJECT_PREFIX = /^\s*(?:(?:re|aw|fw|fwd|wg)\s*(?:\[\d+\])?\s*:\s*)+/i;

/** A subject or summary as the repeat check compares it: without reply/forward prefixes, spacing and case. */
export function normaliseSubject(text: string): string {
  return text.replace(SUBJECT_PREFIX, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * The words of a subject as a Jira text search term: letters and digits only, since the text
 * search reads many punctuation marks as operators. It only finds candidates; the exact compare is
 * done on the normalised text. Empty when the subject has no words.
 */
export function subjectSearchTerm(subject: string): string {
  return normaliseSubject(subject).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** For each subject, the tickets whose summary is the same after normalising, in the order Jira returned them. */
export function matchRepeats(
  subjects: Record<string, string>, tickets: Array<{ key: string; summary: string }>,
): Record<string, Array<{ key: string; summary: string }>> {
  const byText = new Map<string, Array<{ key: string; summary: string }>>();
  for (const t of tickets) {
    const text = normaliseSubject(t.summary);
    if (!text) continue;
    byText.set(text, [...(byText.get(text) ?? []), t]);
  }
  const repeats: Record<string, Array<{ key: string; summary: string }>> = {};
  for (const [id, subject] of Object.entries(subjects)) {
    const hits = byText.get(normaliseSubject(subject));
    if (hits && hits.length > 0) repeats[id] = hits;
  }
  return repeats;
}
