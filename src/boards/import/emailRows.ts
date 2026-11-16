import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { parseEmlBuffer } from '../../utils/emlParser';
import type { ReviewRowBase } from '../../imports/types';
import type { EmailBoardRow } from './read';

// An email row as a write needs it. The session keeps no attachment content, so every write reads
// the email's file again for the attachments, and takes the body (cleaned or not) from the session.
// vscode-free.

export type EmailWriteRow = EmailBoardRow & ReviewRowBase;

/** What the cleanup step decided for an email: the body to write and the inline images it no longer refers to. */
export interface EmailBodyChoice {
  markdownBody: string;
  droppedImages: string[];
}

/** The hash an email row keeps of its file's content as the board read it. */
export function emailContentHash(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 32);
}

function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

/** The refusal for an email whose file is gone. */
export function missingEmailFile(filePath: string): string {
  return `The file ${path.basename(filePath)} is no longer there, so nothing was written for this email. Pick the file again to import it.`;
}

/**
 * The row with its attachments read from the file again and the chosen body, or why it cannot be
 * written: the file is gone or no longer reads.
 */
export async function emailRowForWrite(row: EmailWriteRow, body?: EmailBodyChoice): Promise<{ row: EmailWriteRow } | { refused: string }> {
  let attachments: EmailWriteRow['attachments'];
  try {
    const content = await fs.promises.readFile(row.emlFilePath);
    // A different email saved under the same name would mix two emails in one ticket.
    if (row.contentHash && emailContentHash(content) !== row.contentHash) {
      return { refused: `The file ${path.basename(row.emlFilePath)} changed since the board read it, so nothing was written for this email. Refresh to read it again.` };
    }
    attachments = (await parseEmlBuffer(content, row.emlFilePath)).attachments;
  } catch (err) {
    if (isMissing(err)) return { refused: missingEmailFile(row.emlFilePath) };
    return { refused: `The file ${path.basename(row.emlFilePath)} could not be read again, so nothing was written for this email: ${err instanceof Error ? err.message : String(err)}` };
  }
  const dropped = new Set(body?.droppedImages ?? []);
  return {
    row: {
      ...row,
      ...(body ? { markdownBody: body.markdownBody } : {}),
      attachments: attachments.filter(a => !(a.isInline && dropped.has(a.name))),
    },
  };
}

/** The handler name the email cleanup step keeps its state under in the session's working state. */
export const EMAIL_CLEANUP_HANDLER = 'email-cleanup';

/** The body the cleanup step chose for an email, by the email's file path; undefined while it chose none (the email is written as read). */
export function chosenEmailBody(ext: Record<string, unknown>, filePath: string): EmailBodyChoice | undefined {
  const state = ext[EMAIL_CLEANUP_HANDLER] as { bodies?: Record<string, EmailBodyChoice> } | undefined;
  return state?.bodies?.[filePath];
}
