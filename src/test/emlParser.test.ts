import { describe, it, expect } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import { parseEml } from '../utils/emlParser';

const FIXTURE = path.resolve(process.cwd(), 'src/test/fixtures/eml/sample.eml');

describe('parseEml — fixture: sample.eml', () => {
  it('parses subject from headers', async () => {
    const result = await parseEml(fs.readFileSync(FIXTURE));
    expect(result.subject).toBe('Test Email Subject');
  });

  it('parses sender name from From header', async () => {
    const result = await parseEml(fs.readFileSync(FIXTURE));
    expect(result.senderName).toBe('Jane Doe');
  });

  it('parses date as ISO 8601 string', async () => {
    const result = await parseEml(fs.readFileSync(FIXTURE));
    expect(result.receivedDateTime).toBe('2026-05-22T15:22:00.000Z');
  });

  it('returns htmlBody from HTML part', async () => {
    const result = await parseEml(fs.readFileSync(FIXTURE));
    expect(result.htmlBody).toContain('Hello');
    expect(result.htmlBody).toContain('<strong>World</strong>');
  });

  it('maps contentId to filename in inlineImageMap', async () => {
    const result = await parseEml(fs.readFileSync(FIXTURE));
    expect(result.inlineImageMap.get('image001@test.com')).toBe('email-image-1.png');
  });

  it('marks inline image attachment with isInline true', async () => {
    const result = await parseEml(fs.readFileSync(FIXTURE));
    const img = result.attachments.find(a => a.name === 'email-image-1.png');
    expect(img).toBeDefined();
    expect(img!.isInline).toBe(true);
  });

  it('marks file attachment with isInline false', async () => {
    const result = await parseEml(fs.readFileSync(FIXTURE));
    const pdf = result.attachments.find(a => a.name === 'report.pdf');
    expect(pdf).toBeDefined();
    expect(pdf!.isInline).toBe(false);
  });

  it('returns valid base64 for all attachment contentBytes', async () => {
    const result = await parseEml(fs.readFileSync(FIXTURE));
    for (const att of result.attachments) {
      expect(att.contentBytes).toMatch(/^[A-Za-z0-9+/]+=*$/);
    }
  });
});

describe('parseEml — edge cases', () => {
  it('defaults subject to "(no subject)" when Subject header absent', async () => {
    const eml = Buffer.from('From: t@t.com\r\nContent-Type: text/plain\r\n\r\nhello');
    const result = await parseEml(eml);
    expect(result.subject).toBe('(no subject)');
  });

  it('defaults senderName to "Unknown" when From header absent', async () => {
    const eml = Buffer.from('Subject: Hi\r\nContent-Type: text/plain\r\n\r\nhello');
    const result = await parseEml(eml);
    expect(result.senderName).toBe('Unknown');
  });

  it('uses current time when Date header absent', async () => {
    const before = Date.now();
    const eml = Buffer.from('Subject: Hi\r\nContent-Type: text/plain\r\n\r\nhello');
    const result = await parseEml(eml);
    const after = Date.now();
    const parsed = new Date(result.receivedDateTime).getTime();
    expect(parsed).toBeGreaterThanOrEqual(before);
    expect(parsed).toBeLessThanOrEqual(after + 50);
  });

  it('handles plain-text-only email — htmlBody undefined, plainBody set', async () => {
    const eml = Buffer.from('Subject: Plain\r\nContent-Type: text/plain\r\n\r\nJust plain text');
    const result = await parseEml(eml);
    expect(result.htmlBody).toBeUndefined();
    expect(result.plainBody).toBe('Just plain text');
  });
});
