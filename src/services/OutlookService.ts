import type { IOutlookClient, FolderItem, EmailListItem, EmailAttachment } from '../outlook/IOutlookClient';
import { htmlToMarkdown } from '../utils/htmlToMarkdown';

export class OutlookService {
  constructor(private readonly client: IOutlookClient) {}

  async getFolders(): Promise<FolderItem[]> {
    return this.client.listFolders();
  }

  async listFoldersForDisplay(): Promise<string> {
    const folders = await this.client.listFolders();
    return folders
      .map((f, i) => `${i + 1}. ${f.displayName} (${f.unreadItemCount} unread)`)
      .join('\n');
  }

  async getEmails(folderId: string, limit: number): Promise<EmailListItem[]> {
    return this.client.listEmails(folderId, limit);
  }

  async listEmailsForDisplay(folderId: string, limit: number): Promise<string> {
    const emails = await this.client.listEmails(folderId, limit);
    return emails
      .map((e, i) => {
        const date = e.receivedDateTime.slice(0, 10);
        return `${i + 1}. [${date}] ${e.subject} (${e.senderName})`;
      })
      .join('\n');
  }

  async fetchEmailForTicket(emailId: string): Promise<{
    subject: string;
    markdownBody: string;
    inlineImageMap: Record<string, string>;
    attachments: EmailAttachment[];
  }> {
    const email = await this.client.getEmail(emailId);

    const inlineImageMap: Record<string, string> = {};
    for (const att of email.attachments) {
      if (att.isInline && att.contentId) {
        inlineImageMap[att.contentId] = att.name;
      }
    }

    let markdownBody: string;
    if (email.bodyHtml.trim()) {
      markdownBody = htmlToMarkdown(email.bodyHtml, new Map(Object.entries(inlineImageMap)));
    } else {
      markdownBody = email.bodyText;
    }

    return { subject: email.subject, markdownBody, inlineImageMap, attachments: email.attachments };
  }
}
