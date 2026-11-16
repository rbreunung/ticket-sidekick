import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildEmailCommentWiki, checkEmailBatchCaps, createEmailDescriptor } from '../imports/email';
import type { TicketService } from '../services/TicketService';
import type { EmailReviewRow } from '../utils/emlParser';

// The email importer outside the chat: what a created ticket gets afterwards, the comment an email
// becomes, and the caps checked before any file of a selection is read.

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'email-import-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function rowFor(emlFilePath: string, attachments: EmailReviewRow['attachments']): EmailReviewRow {
  return {
    id: '1', existingTicketKey: null, included: true, subject: 'Login fails', attachmentNames: attachments.map(a => a.name),
    markdownBody: 'Body', inlineImageMap: {}, attachments, emlFilePath,
  };
}

const attachment = (name: string) => ({ name, contentType: 'text/plain', contentBytes: Buffer.from(name).toString('base64'), isInline: false });

describe('email descriptor after a ticket is created', () => {
  it('deletes the .eml when the setting is on and every attachment uploaded', async () => {
    const eml = path.join(dir, 'mail.eml');
    fs.writeFileSync(eml, 'x');
    const ticketService = { uploadAttachment: async () => undefined } as unknown as TicketService;
    const descriptor = createEmailDescriptor({ deleteEmlAfterImport: () => true, maxBatchBytes: () => 1024 });
    await descriptor.afterCreate!(rowFor(eml, [attachment('log.txt')]), 'PROJ-1', ticketService);
    expect(fs.existsSync(eml)).toBe(false);
  });

  it('uploads what it can, reports the failed upload, and keeps the .eml even with the setting on', async () => {
    const eml = path.join(dir, 'mail.eml');
    fs.writeFileSync(eml, 'x');
    const uploaded: string[] = [];
    const ticketService = {
      uploadAttachment: async (_key: string, name: string) => {
        if (name === 'broken.txt') throw new Error('too large');
        uploaded.push(name);
      },
    } as unknown as TicketService;
    const descriptor = createEmailDescriptor({ deleteEmlAfterImport: () => true, maxBatchBytes: () => 1024 });

    await expect(descriptor.afterCreate!(rowFor(eml, [attachment('log.txt'), attachment('broken.txt')]), 'PROJ-1', ticketService))
      .rejects.toThrow('Uploaded 1 of 2 attachment(s); failed: broken.txt: too large. The .eml file was kept.');
    expect(uploaded).toEqual(['log.txt']);
    expect(fs.existsSync(eml)).toBe(true);
  });

  it('keeps the .eml when the setting is off', async () => {
    const eml = path.join(dir, 'mail.eml');
    fs.writeFileSync(eml, 'x');
    const descriptor = createEmailDescriptor({ deleteEmlAfterImport: () => false, maxBatchBytes: () => 1024 });
    await descriptor.afterCreate!(rowFor(eml, []), 'PROJ-1', {} as TicketService);
    expect(fs.existsSync(eml)).toBe(true);
  });
});

describe('email comment', () => {
  it('starts with the sender and date, then the body as wiki markup', () => {
    expect(buildEmailCommentWiki({ senderName: 'Ann', receivedDateTime: '2026-11-16T08:00:00Z', markdownBody: '**Hi**' }))
      .toBe('*From:* Ann  ·  *Date:* 2026-11-16\n\n*Hi*');
  });
});

describe('email batch caps', () => {
  it('refuses more than 50 files before reading any', async () => {
    const paths = Array.from({ length: 51 }, (_, i) => path.join(dir, `missing-${i}.eml`));
    expect(await checkEmailBatchCaps(paths, 1024)).toMatch(/Selected 51 files — the batch limit is 50/);
  });

  it('refuses a selection over the size cap and names the cap', async () => {
    const eml = path.join(dir, 'big.eml');
    fs.writeFileSync(eml, Buffer.alloc(2 * 1024 * 1024));
    expect(await checkEmailBatchCaps([eml], 1024 * 1024)).toMatch(/total 2\.0 MB — the batch limit is 1 MB/);
    expect(await checkEmailBatchCaps([eml], 3 * 1024 * 1024)).toBeNull();
  });
});

describe('likely repeats', () => {
  it('compares subjects without reply prefixes, spacing or case', async () => {
    const { matchRepeats, normaliseSubject, subjectSearchTerm } = await import('../imports/email');
    expect(normaliseSubject('AW: WG:  Login   Fails')).toBe('login fails');
    expect(subjectSearchTerm('RE: [Prod] Login fails?')).toBe('prod login fails');
    expect(matchRepeats({ 1: 'RE: Login fails', 2: 'Other' }, [{ key: 'P-1', summary: 'login fails' }, { key: 'P-2', summary: 'Login fails today' }]))
      .toEqual({ 1: [{ key: 'P-1', summary: 'login fails' }] });
  });
});
