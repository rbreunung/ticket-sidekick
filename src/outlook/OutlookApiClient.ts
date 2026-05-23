import type { IOutlookClient, FolderItem, EmailListItem, EmailMessage, EmailAttachment } from './IOutlookClient';
import type { TokenProvider } from './tokenProviders';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0/me';

export class OutlookApiClient implements IOutlookClient {
  constructor(private readonly getToken: TokenProvider) {}

  private async fetch<T>(path: string): Promise<T> {
    const token = await this.getToken();
    const response = await fetch(`${GRAPH_BASE}${path}`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Graph API error ${response.status}: ${text}`);
    }
    return response.json() as Promise<T>;
  }

  async listFolders(): Promise<FolderItem[]> {
    const data = await this.fetch<{ value: Array<{ id: string; displayName: string; unreadItemCount: number }> }>(
      '/mailFolders?$select=id,displayName,unreadItemCount&$top=25',
    );
    return data.value.map(f => ({ id: f.id, displayName: f.displayName, unreadItemCount: f.unreadItemCount }));
  }

  async listEmails(folderId: string, limit: number): Promise<EmailListItem[]> {
    const data = await this.fetch<{ value: Array<{ id: string; subject: string; receivedDateTime: string; from: { emailAddress: { name: string } } }> }>(
      `/mailFolders/${encodeURIComponent(folderId)}/messages?$select=id,subject,receivedDateTime,from&$top=${limit}&$orderby=receivedDateTime desc`,
    );
    return data.value.map(m => ({
      id: m.id,
      subject: m.subject ?? '(no subject)',
      receivedDateTime: m.receivedDateTime,
      senderName: m.from?.emailAddress?.name ?? 'Unknown',
    }));
  }

  async getEmail(emailId: string): Promise<EmailMessage> {
    const m = await this.fetch<{
      id: string; subject: string; receivedDateTime: string;
      from: { emailAddress: { name: string } };
      body: { contentType: string; content: string };
      attachments?: Array<{
        '@odata.type': string; name: string; contentType: string;
        contentBytes: string; isInline: boolean; contentId?: string;
      }>;
    }>(`/messages/${encodeURIComponent(emailId)}?$expand=attachments`);

    const isHtml = m.body.contentType.toLowerCase() === 'html';
    const attachments: EmailAttachment[] = (m.attachments ?? [])
      .filter(a => a['@odata.type'] === '#microsoft.graph.fileAttachment')
      .map(a => ({
        name: a.name,
        contentType: a.contentType,
        contentBytes: a.contentBytes,
        isInline: a.isInline,
        contentId: a.contentId,
      }));

    return {
      id: m.id,
      subject: m.subject ?? '(no subject)',
      receivedDateTime: m.receivedDateTime,
      senderName: m.from?.emailAddress?.name ?? 'Unknown',
      bodyHtml: isHtml ? m.body.content : '',
      bodyText: isHtml ? '' : m.body.content,
      attachments,
    };
  }
}
