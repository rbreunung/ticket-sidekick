import PostalMime from 'postal-mime';
import * as fs from 'fs';
import { htmlToMarkdown } from './htmlToMarkdown';

export interface ParsedEml {
  subject: string;
  senderName: string;
  receivedDateTime: string;
  htmlBody: string | undefined;
  plainBody: string | undefined;
  inlineImageMap: Map<string, string>;
  attachments: Array<{
    name: string;
    contentType: string;
    contentBytes: string;
    isInline: boolean;
  }>;
}

export async function parseEml(buffer: Buffer): Promise<ParsedEml> {
  const email = await new PostalMime().parse(buffer);

  const subject = email.subject ?? '(no subject)';
  const senderName = email.from?.name || email.from?.address || 'Unknown';
  const receivedDateTime = email.date
    ? new Date(email.date).toISOString()
    : new Date().toISOString();
  const htmlBody = email.html || undefined;
  const plainBody = email.text ? email.text.trimEnd() : undefined;

  const inlineImageMap = new Map<string, string>();
  const attachments: ParsedEml['attachments'] = [];

  for (const att of email.attachments ?? []) {
    const isInline = att.disposition === 'inline' || att.related === true;
    const name = att.filename ?? att.mimeType.replace('/', '-');
    const raw = att.content instanceof ArrayBuffer ? new Uint8Array(att.content) : att.content;
    const contentBytes = Buffer.from(raw as Uint8Array | string).toString('base64');

    if (isInline && att.contentId) {
      const cid = att.contentId.replace(/^<|>$/g, '');
      inlineImageMap.set(cid, name);
    }

    attachments.push({
      name,
      contentType: att.mimeType ?? 'application/octet-stream',
      contentBytes,
      isInline,
    });
  }

  return { subject, senderName, receivedDateTime, htmlBody, plainBody, inlineImageMap, attachments };
}

// One already-parsed, ready-to-review .eml file — the shape batch email import's ReportImportDescriptor
// works with (TItem). Colocated with parseEml() rather than in sessionState.ts so it can be shared by
// sessionState.ts (session/row type aliases) and emailHandler.ts (vscode-dependent handler code)
// without a type-only circular import — same reasoning as VeracodeReviewRow living in veracodeReport.ts.
export interface EmailImportItem {
  subject: string;
  senderName?: string;
  receivedDateTime?: string;
  markdownBody: string;
  inlineImageMap: Record<string, string>;
  attachments: ParsedEml['attachments'];
  emlFilePath: string;
}

// Review-row shape for batch email import (TRow) — id/existingTicketKey/included are inlined rather
// than importing ReviewRowBase, matching VeracodeReviewRow's/WaltzReviewRow's convention.
export interface EmailReviewRow {
  id: string; // '1'..'N' in selection order — email import has no dedup concept, so no 'A'-prefixed ids
  existingTicketKey: string | null; // always null — no dedup concept for email batches
  included: boolean;
  subject: string;
  senderName?: string;
  attachmentNames: string[]; // non-inline attachment names, for the review table's Attachments column
  markdownBody: string;
  inlineImageMap: Record<string, string>;
  attachments: ParsedEml['attachments'];
  emlFilePath: string;
}

// Reads and parses one .eml file into the shape a batch review row builds from. Replaces the three
// duplicated read-file/parseEml/build-markdown-body/build-attachments blocks that used to live
// inline in emailHandler.ts's openEmailFilePicker/handleAddEmailFromChat and extension.ts's
// ticket-sidekick.importEml command.
export async function parseEmlFile(filePath: string): Promise<EmailImportItem> {
  const buffer = await fs.promises.readFile(filePath);
  const parsed = await parseEml(buffer);
  const markdownBody = parsed.htmlBody
    ? htmlToMarkdown(parsed.htmlBody, parsed.inlineImageMap)
    : (parsed.plainBody ?? '');
  const inlineImageMap: Record<string, string> = {};
  for (const [k, v] of parsed.inlineImageMap) inlineImageMap[k] = v;
  return {
    subject: parsed.subject,
    senderName: parsed.senderName,
    receivedDateTime: parsed.receivedDateTime,
    markdownBody,
    inlineImageMap,
    attachments: parsed.attachments,
    emlFilePath: filePath,
  };
}
