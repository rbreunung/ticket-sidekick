import type { IOutlookClient, FolderItem, EmailListItem, EmailMessage } from '../../outlook/IOutlookClient';

export const MOCK_FOLDERS: FolderItem[] = [
  { id: 'folder-inbox', displayName: 'Inbox', unreadItemCount: 5 },
  { id: 'folder-support', displayName: 'Support', unreadItemCount: 2 },
];

export const MOCK_EMAIL_LIST: EmailListItem[] = [
  { id: 'email-1', subject: 'Login failing on mobile', receivedDateTime: '2026-05-20T10:00:00Z', senderName: 'Alice Smith' },
  { id: 'email-2', subject: 'Payment timeout error', receivedDateTime: '2026-05-19T09:00:00Z', senderName: 'Bob Jones' },
];

export const MOCK_EMAIL_HTML: EmailMessage = {
  id: 'email-1',
  subject: 'Login failing on mobile',
  receivedDateTime: '2026-05-20T10:00:00Z',
  senderName: 'Alice Smith',
  bodyHtml: '<h1>Bug Report</h1><p>Steps to reproduce:<br/>1. Open app<br/>2. Tap Login</p><img src="cid:img001@host" />',
  bodyText: 'Bug Report\nSteps to reproduce:\n1. Open app\n2. Tap Login',
  attachments: [
    { name: 'screenshot.png', contentType: 'image/png', contentBytes: 'base64data', isInline: true, contentId: 'img001@host' },
    { name: 'log.txt', contentType: 'text/plain', contentBytes: 'base64log', isInline: false },
  ],
};

export const MOCK_EMAIL_PLAIN: EmailMessage = {
  id: 'email-2',
  subject: 'Payment timeout error',
  receivedDateTime: '2026-05-19T09:00:00Z',
  senderName: 'Bob Jones',
  bodyHtml: '',
  bodyText: 'The payment gateway is timing out after 30 seconds.',
  attachments: [],
};

export class MockOutlookClient implements IOutlookClient {
  async listFolders(): Promise<FolderItem[]> { return MOCK_FOLDERS; }
  async listEmails(_folderId: string, _limit: number): Promise<EmailListItem[]> { return MOCK_EMAIL_LIST; }
  async getEmail(emailId: string): Promise<EmailMessage> {
    if (emailId === 'email-2') return MOCK_EMAIL_PLAIN;
    return MOCK_EMAIL_HTML;
  }
}
