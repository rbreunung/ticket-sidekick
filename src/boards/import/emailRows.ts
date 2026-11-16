import * as path from 'path';
import { parseEmlFile } from '../../utils/emlParser';
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
    attachments = (await parseEmlFile(row.emlFilePath)).attachments;
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
