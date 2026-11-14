// The single-file "add email as a comment" session and the resolution pick of an import's stale close.
// Pure (vscode-free); re-exported through ../sessionState.ts.

import { pickByNumberOrName } from './primitives';

// The remaining fields (once template/issue-type selection and ticket creation moved to
// EmailTemplateSelectionSession/EmailReviewSession — see KTD1 in reportImportHandler.ts) are exactly
// what the single-file "add email as a comment" flow needs.
export interface EmailContentSession {
  emailId: string;
  subject: string;
  senderName?: string;
  receivedDateTime?: string;
  markdownBody: string;
  inlineImageMap: Record<string, string>;
  attachments: Array<{
    name: string; contentType: string; contentBytes: string;
    isInline: boolean; contentId?: string;
  }>;
  emlFilePath?: string;
  pendingCommentTicketKey?: string;
}

export function parseResolutionSelection(reply: string, options: string[]): string | null | 'invalid' {
  const normalized = reply.trim().toLowerCase();
  if (normalized === 'none' || normalized === 'skip') return null;
  return pickByNumberOrName(reply, options, (s) => s) ?? 'invalid';
}
