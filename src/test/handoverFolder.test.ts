import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { readHandoverEmail, deleteHandoverFile, purgeStaleFiles } from '../utils/handoverFolder';

const FIXTURES = path.resolve(process.cwd(), 'src/test/fixtures/email-handover');
const TIMESTAMP = 'test-session-1';

describe('readHandoverEmail', () => {
  it('parses subject, sender, date from manifest', async () => {
    const email = await readHandoverEmail(FIXTURES, TIMESTAMP);
    expect(email.subject).toBe('Test Email Subject');
    expect(email.senderName).toBe('Jane Doe');
    expect(email.receivedDateTime).toBe('2026-05-23T10:00:00Z');
  });

  it('converts HTML body to markdown', async () => {
    const email = await readHandoverEmail(FIXTURES, TIMESTAMP);
    expect(email.markdownBody).toContain('Hello **World**');
    expect(email.markdownBody).toContain('See the attached image');
  });

  it('positions inline image as ![name](name) in markdownBody', async () => {
    const email = await readHandoverEmail(FIXTURES, TIMESTAMP);
    expect(email.markdownBody).toContain('![email-image-1.png](email-image-1.png)');
  });

  it('returns base64 data for inline images', async () => {
    const email = await readHandoverEmail(FIXTURES, TIMESTAMP);
    const img = email.attachments.find(a => a.name === 'email-image-1.png');
    expect(img).toBeDefined();
    expect(img!.dataBase64).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });

  it('returns base64 data for file attachments', async () => {
    const email = await readHandoverEmail(FIXTURES, TIMESTAMP);
    const pdf = email.attachments.find(a => a.name === 'report.pdf');
    expect(pdf).toBeDefined();
    expect(pdf!.dataBase64).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });

  it('returns isInline:true for images, isInline:false for attachments', async () => {
    const email = await readHandoverEmail(FIXTURES, TIMESTAMP);
    const img = email.attachments.find(a => a.name === 'email-image-1.png');
    const pdf = email.attachments.find(a => a.name === 'report.pdf');
    expect(img!.isInline).toBe(true);
    expect(pdf!.isInline).toBe(false);
  });

  it('returns handoverFolder and timestamp for later cleanup', async () => {
    const email = await readHandoverEmail(FIXTURES, TIMESTAMP);
    expect(email.handoverFolder).toBe(FIXTURES);
    expect(email.timestamp).toBe(TIMESTAMP);
  });

  it('throws when manifest file not found', async () => {
    await expect(readHandoverEmail(FIXTURES, 'nonexistent-session')).rejects.toThrow(
      /Could not read handover manifest/
    );
  });

  it('throws when manifest JSON is invalid', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-test-'));
    fs.writeFileSync(path.join(tmpDir, 'TicketSidekick-bad.json'), 'not json');
    await expect(readHandoverEmail(tmpDir, 'bad')).rejects.toThrow(/Could not read handover manifest/);
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('throws when scriptVersion is missing (old script)', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-ver-'));
    fs.writeFileSync(path.join(tmpDir, 'TicketSidekick-v0.json'), JSON.stringify({
      subject: 'x', senderName: 'x', receivedDateTime: 'x', bodyHtml: '', stripFooter: false,
    }));
    await expect(readHandoverEmail(tmpDir, 'v0')).rejects.toThrow(/manifest version mismatch/);
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('throws when scriptVersion is below required (old script)', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-ver-'));
    fs.writeFileSync(path.join(tmpDir, 'TicketSidekick-v1.json'), JSON.stringify({
      scriptVersion: 1,
      subject: 'x', senderName: 'x', receivedDateTime: 'x', bodyHtml: '', stripFooter: false,
    }));
    await expect(readHandoverEmail(tmpDir, 'v1')).rejects.toThrow(/manifest version mismatch/);
    fs.rmSync(tmpDir, { recursive: true });
  });
});

describe('deleteHandoverFile', () => {
  it('removes the JSON file', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-del-'));
    const ts = '9999999999999';
    fs.writeFileSync(path.join(tmpDir, `TicketSidekick-${ts}.json`), '{}');
    await deleteHandoverFile(tmpDir, ts);
    expect(fs.existsSync(path.join(tmpDir, `TicketSidekick-${ts}.json`))).toBe(false);
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('does not throw when file does not exist', async () => {
    await expect(deleteHandoverFile('/tmp', 'nonexistent-ts')).resolves.not.toThrow();
  });
});

describe('purgeStaleFiles', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-purge-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('deletes TicketSidekick-*.json files older than maxAgeMs', async () => {
    const ts = '1000000000000';
    const filePath = path.join(tmpDir, `TicketSidekick-${ts}.json`);
    fs.writeFileSync(filePath, '{}');
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(filePath, old, old);
    await purgeStaleFiles(tmpDir, 60 * 60 * 1000);
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('keeps files newer than maxAgeMs', async () => {
    const ts = '9999999999999';
    const filePath = path.join(tmpDir, `TicketSidekick-${ts}.json`);
    fs.writeFileSync(filePath, '{}');
    await purgeStaleFiles(tmpDir, 60 * 60 * 1000);
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it('ignores non-TicketSidekick files', async () => {
    const filePath = path.join(tmpDir, 'other-file.json');
    fs.writeFileSync(filePath, '{}');
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(filePath, old, old);
    await purgeStaleFiles(tmpDir, 60 * 60 * 1000);
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it('does not throw when handoverFolder does not exist', async () => {
    await expect(purgeStaleFiles('/tmp/nonexistent-ts-folder-xyz', 1000)).resolves.not.toThrow();
  });
});
