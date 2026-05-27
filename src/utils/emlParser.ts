import PostalMime from 'postal-mime';

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
