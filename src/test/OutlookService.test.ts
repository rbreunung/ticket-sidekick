import { describe, it, expect } from 'vitest';
import { OutlookService } from '../services/OutlookService';
import { MockOutlookClient, MOCK_FOLDERS, MOCK_EMAIL_LIST } from './mocks/MockOutlookClient';

describe('OutlookService.listFoldersForDisplay', () => {
  it('returns a numbered markdown list with unread counts', async () => {
    const svc = new OutlookService(new MockOutlookClient());
    const result = await svc.listFoldersForDisplay();
    expect(result).toContain('1. Inbox (5 unread)');
    expect(result).toContain('2. Support (2 unread)');
    expect(result).toHaveLength(result.length); // sanity
  });

  it('returns the folder list used for selection', async () => {
    const svc = new OutlookService(new MockOutlookClient());
    const folders = await svc.getFolders();
    expect(folders).toEqual(MOCK_FOLDERS);
  });
});

describe('OutlookService.listEmailsForDisplay', () => {
  it('returns a numbered markdown list with date, subject, sender', async () => {
    const svc = new OutlookService(new MockOutlookClient());
    const result = await svc.listEmailsForDisplay('folder-inbox', 10);
    expect(result).toContain('1.');
    expect(result).toContain('Login failing on mobile');
    expect(result).toContain('Alice Smith');
    expect(result).toContain('2.');
    expect(result).toContain('Payment timeout error');
  });

  it('returns the email list for selection', async () => {
    const svc = new OutlookService(new MockOutlookClient());
    const emails = await svc.getEmails('folder-inbox', 10);
    expect(emails).toEqual(MOCK_EMAIL_LIST);
  });
});

describe('OutlookService.fetchEmailForTicket', () => {
  it('converts HTML body to Markdown and builds inline image map', async () => {
    const svc = new OutlookService(new MockOutlookClient());
    const result = await svc.fetchEmailForTicket('email-1');
    expect(result.subject).toBe('Login failing on mobile');
    expect(result.markdownBody).toContain('# Bug Report');
    expect(result.markdownBody).toContain('[📎 screenshot.png]');
    expect(result.inlineImageMap).toEqual({ 'img001@host': 'screenshot.png' });
    expect(result.attachments).toHaveLength(2);
  });

  it('uses plain-text body when HTML is empty', async () => {
    const svc = new OutlookService(new MockOutlookClient());
    const result = await svc.fetchEmailForTicket('email-2');
    expect(result.markdownBody).toBe('The payment gateway is timing out after 30 seconds.');
    expect(result.inlineImageMap).toEqual({});
  });
});
