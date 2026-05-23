import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { readHandoverEmail, deleteHandoverSubfolder, purgeStaleSubfolders } from '../utils/handoverFolder';

const FIXTURES = path.resolve(process.cwd(), 'src/test/fixtures/email-handover');
const SUBFOLDER = 'test-session-1';

describe('readHandoverEmail', () => {
  it('parses subject, sender, date from manifest', async () => {
    const email = await readHandoverEmail(FIXTURES, SUBFOLDER);
    expect(email.subject).toBe('Test Email Subject');
    expect(email.senderName).toBe('Jane Doe');
    expect(email.receivedDateTime).toBe('2026-05-23T10:00:00Z');
  });

  it('converts HTML body to markdown', async () => {
    const email = await readHandoverEmail(FIXTURES, SUBFOLDER);
    expect(email.markdownBody).toContain('Hello **World**');
    expect(email.markdownBody).toContain('See the attached image');
  });

  it('positions inline image as ![name](name) in markdownBody', async () => {
    const email = await readHandoverEmail(FIXTURES, SUBFOLDER);
    expect(email.markdownBody).toContain('![email-image-1.png](email-image-1.png)');
  });

  it('lists file attachments with correct absolute filePaths', async () => {
    const email = await readHandoverEmail(FIXTURES, SUBFOLDER);
    const pdf = email.attachments.find(a => a.name === 'report.pdf');
    expect(pdf).toBeDefined();
    expect(pdf!.filePath).toBe(path.join(FIXTURES, SUBFOLDER, 'report.pdf'));
  });

  it('returns isInline:true for images, isInline:false for attachments', async () => {
    const email = await readHandoverEmail(FIXTURES, SUBFOLDER);
    const img = email.attachments.find(a => a.name === 'email-image-1.png');
    const pdf = email.attachments.find(a => a.name === 'report.pdf');
    expect(img!.isInline).toBe(true);
    expect(pdf!.isInline).toBe(false);
  });

  it('returns handoverFolder and subfolder for later cleanup', async () => {
    const email = await readHandoverEmail(FIXTURES, SUBFOLDER);
    expect(email.handoverFolder).toBe(FIXTURES);
    expect(email.subfolder).toBe(SUBFOLDER);
  });

  it('throws when manifest file not found', async () => {
    await expect(readHandoverEmail(FIXTURES, 'nonexistent-subfolder')).rejects.toThrow(
      /Could not read handover manifest/
    );
  });

  it('throws when referenced body file is missing', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-test-'));
    const sub = 'broken-session';
    fs.mkdirSync(path.join(tmpDir, sub));
    fs.writeFileSync(
      path.join(tmpDir, sub, 'email.json'),
      JSON.stringify({
        subject: 'x', senderName: 'x', receivedDateTime: 'x',
        bodyFile: 'missing-body.html', stripFooter: false,
        inlineImages: [], attachments: [],
      }),
    );
    await expect(readHandoverEmail(tmpDir, sub)).rejects.toThrow(/Could not read email body/);
    fs.rmSync(tmpDir, { recursive: true });
  });
});

describe('deleteHandoverSubfolder', () => {
  it('removes the subfolder', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-del-'));
    const sub = 'to-delete';
    fs.mkdirSync(path.join(tmpDir, sub));
    fs.writeFileSync(path.join(tmpDir, sub, 'email.json'), '{}');
    await deleteHandoverSubfolder(tmpDir, sub);
    expect(fs.existsSync(path.join(tmpDir, sub))).toBe(false);
    fs.rmSync(tmpDir, { recursive: true });
  });
});

describe('purgeStaleSubfolders', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-purge-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('deletes subfolders older than maxAgeMs', async () => {
    const sub = 'old-session';
    fs.mkdirSync(path.join(tmpDir, sub));
    // Set mtime to 2 hours ago
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(path.join(tmpDir, sub), old, old);
    await purgeStaleSubfolders(tmpDir, 60 * 60 * 1000); // maxAge = 1 hour
    expect(fs.existsSync(path.join(tmpDir, sub))).toBe(false);
  });

  it('keeps subfolders newer than maxAgeMs', async () => {
    const sub = 'new-session';
    fs.mkdirSync(path.join(tmpDir, sub));
    await purgeStaleSubfolders(tmpDir, 60 * 60 * 1000); // maxAge = 1 hour
    expect(fs.existsSync(path.join(tmpDir, sub))).toBe(true);
  });

  it('does not throw when handoverFolder does not exist', async () => {
    await expect(purgeStaleSubfolders('/tmp/nonexistent-ts-folder-xyz', 1000)).resolves.not.toThrow();
  });
});
