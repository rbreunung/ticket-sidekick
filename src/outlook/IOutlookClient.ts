export interface FolderItem {
  id: string;
  displayName: string;
  unreadItemCount: number;
}

export interface EmailListItem {
  id: string;
  subject: string;
  receivedDateTime: string;  // ISO 8601
  senderName: string;
}

export interface EmailAttachment {
  name: string;
  contentType: string;
  contentBytes: string;  // base64
  isInline: boolean;
  contentId?: string;    // matches cid: references in HTML body
}

export interface EmailMessage extends EmailListItem {
  bodyHtml: string;      // empty string when email is plain-text only
  bodyText: string;      // plain-text body (always present)
  attachments: EmailAttachment[];
}

export interface IOutlookClient {
  listFolders(): Promise<FolderItem[]>;
  listEmails(folderId: string, limit: number): Promise<EmailListItem[]>;
  getEmail(emailId: string): Promise<EmailMessage>;
}
