import * as fs from 'fs';
import * as path from 'path';
import { htmlToMarkdown } from './htmlToMarkdown';
import type { HandoverEmail } from '../participant/sessionState';

interface HandoverManifest {
  subject: string;
  senderName: string;
  receivedDateTime: string;
  bodyFile: string;
  stripFooter: boolean;
  inlineImages: Array<{ filename: string; contentType: string }>;
  attachments: Array<{ filename: string; contentType: string }>;
}

export async function readHandoverEmail(handoverFolder: string, subfolder: string): Promise<HandoverEmail> {
  const dir = path.join(handoverFolder, subfolder);
  const manifestPath = path.join(dir, 'email.json');

  let manifest: HandoverManifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as HandoverManifest;
  } catch {
    throw new Error(`Could not read handover manifest at ${manifestPath}`);
  }

  const bodyPath = path.join(dir, manifest.bodyFile);
  let bodyHtml: string;
  try {
    bodyHtml = fs.readFileSync(bodyPath, 'utf-8');
  } catch {
    throw new Error(`Could not read email body at ${bodyPath}`);
  }

  const markdownBody = htmlToMarkdown(bodyHtml);

  return {
    subject: manifest.subject,
    senderName: manifest.senderName,
    receivedDateTime: manifest.receivedDateTime,
    markdownBody,
    stripFooter: manifest.stripFooter,
    handoverFolder,
    subfolder,
    attachments: [
      ...manifest.inlineImages.map(img => ({
        name: img.filename,
        contentType: img.contentType,
        filePath: path.join(dir, img.filename),
        isInline: true,
      })),
      ...manifest.attachments.map(att => ({
        name: att.filename,
        contentType: att.contentType,
        filePath: path.join(dir, att.filename),
        isInline: false,
      })),
    ],
  };
}

export async function deleteHandoverSubfolder(handoverFolder: string, subfolder: string): Promise<void> {
  fs.rmSync(path.join(handoverFolder, subfolder), { recursive: true, force: true });
}

export async function purgeStaleSubfolders(handoverFolder: string, maxAgeMs: number = 24 * 60 * 60 * 1000): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(handoverFolder, { withFileTypes: true });
  } catch {
    return;
  }

  const now = Date.now();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const entryPath = path.join(handoverFolder, entry.name);
    try {
      const stat = fs.statSync(entryPath);
      if (now - stat.mtimeMs > maxAgeMs) {
        fs.rmSync(entryPath, { recursive: true, force: true });
      }
    } catch {
      // Already deleted (race condition) — skip
    }
  }
}
