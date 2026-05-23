import * as fs from 'fs';
import * as path from 'path';
import { htmlToMarkdown } from './htmlToMarkdown';
import type { HandoverEmail } from '../participant/sessionState';

interface HandoverManifest {
  subject: string;
  senderName: string;
  receivedDateTime: string;
  bodyHtml: string;
  stripFooter: boolean;
  inlineImages: Array<{ filename: string; contentType: string; dataBase64: string }>;
  attachments: Array<{ filename: string; contentType: string; dataBase64: string }>;
}

export async function readHandoverEmail(handoverFolder: string, timestamp: string): Promise<HandoverEmail> {
  const filePath = path.join(handoverFolder, `TicketSidekick-${timestamp}.json`);

  let manifest: HandoverManifest;
  try {
    const raw = await fs.promises.readFile(filePath, 'utf-8');
    manifest = JSON.parse(raw) as HandoverManifest;
  } catch {
    throw new Error(`Could not read handover manifest at ${filePath}`);
  }

  const markdownBody = htmlToMarkdown(manifest.bodyHtml);

  return {
    subject: manifest.subject,
    senderName: manifest.senderName,
    receivedDateTime: manifest.receivedDateTime,
    markdownBody,
    stripFooter: manifest.stripFooter,
    handoverFolder,
    timestamp,
    attachments: [
      ...manifest.inlineImages.map(img => ({
        name: img.filename,
        contentType: img.contentType,
        dataBase64: img.dataBase64,
        isInline: true,
      })),
      ...manifest.attachments.map(att => ({
        name: att.filename,
        contentType: att.contentType,
        dataBase64: att.dataBase64,
        isInline: false,
      })),
    ],
  };
}

export async function deleteHandoverFile(handoverFolder: string, timestamp: string): Promise<void> {
  await fs.promises.unlink(path.join(handoverFolder, `TicketSidekick-${timestamp}.json`)).catch(() => {});
}

export async function purgeStaleFiles(handoverFolder: string, maxAgeMs: number = 24 * 60 * 60 * 1000): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(handoverFolder, { withFileTypes: true });
  } catch {
    return;
  }

  const now = Date.now();
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith('TicketSidekick-') || !entry.name.endsWith('.json')) continue;
    const filePath = path.join(handoverFolder, entry.name);
    try {
      const stat = await fs.promises.stat(filePath);
      if (now - stat.mtimeMs > maxAgeMs) {
        await fs.promises.unlink(filePath);
      }
    } catch {
      // Already deleted (race condition) — skip
    }
  }
}
