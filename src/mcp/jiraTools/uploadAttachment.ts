import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { MAX_ATTACHMENT_BYTES } from '../../jira/JiraApiClient';
import { fingerprint } from '../../tools/recentCallGuard';
import { formatFileSize, inferContentType } from '../../utils/attachmentEligibility';
import { defineTool } from '../mcpServer';
import type { JiraToolDeps } from './jiraAccess';
import { runJiraTool } from './runJiraTool';
import { ticketKeyProblem } from './ticketKeyInput';
import { UPLOAD_ATTACHMENT_TOOL } from './toolNames';
import { writeOnce } from './writeGuard';

// Uploads one file from an open workspace folder to a ticket. The path comes from the agent and
// may have been steered by text it read, so only a file that, with symlinks resolved, lies inside
// an open workspace folder, and has no dotfile or dotfolder on the way there, can be sent to Jira.

const uploadShape = {
  ticketKey: z.string().describe('The ticket key, e.g. PROJ-123.'),
  filePath: z.string().describe('The file to upload: absolute, or relative to the first workspace folder.'),
};

type Located = { kind: 'file'; realPath: string } | { kind: 'refused'; answer: string };

async function realPathOf(p: string): Promise<string | undefined> {
  try {
    return await fs.promises.realpath(p);
  } catch {
    return undefined;
  }
}

/** The real path of `filePath` when it may be uploaded, or the answer that says why not. */
async function locateUpload(filePath: string, folders: string[]): Promise<Located> {
  if (folders.length === 0) return { kind: 'refused', answer: 'No workspace folder is open: only files inside an open workspace folder can be uploaded.' };
  const requested = path.isAbsolute(filePath) ? filePath : path.join(folders[0], filePath);
  const realPath = await realPathOf(requested);
  if (!realPath) return { kind: 'refused', answer: `"${filePath}" does not exist.` };
  for (const folder of folders) {
    const realFolder = await realPathOf(folder);
    if (!realFolder) continue;
    const rel = path.relative(realFolder, realPath);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
    if (rel.split(path.sep).some(segment => segment.startsWith('.'))) {
      return { kind: 'refused', answer: `"${filePath}" is in a dotfile or dotfolder, which is never uploaded.` };
    }
    return { kind: 'file', realPath };
  }
  return { kind: 'refused', answer: `"${filePath}" is outside the open workspace folders: only files inside them can be uploaded.` };
}

export const uploadAttachmentTool = defineTool<JiraToolDeps, typeof uploadShape>({
  name: UPLOAD_ATTACHMENT_TOOL,
  title: 'Upload a file to a Jira ticket',
  description:
    'Attaches one file from an open workspace folder to a Jira ticket. Files outside the workspace folders, in a dotfile or dotfolder '
    + '(after following symlinks) or over 25 MB are refused. The same file uploaded to the same ticket within a minute is skipped.',
  inputSchema: uploadShape,
  annotations: { destructiveHint: true },
  handler: async (args, deps) => {
    const key = args.ticketKey.trim();
    const filePath = args.filePath.trim();
    const problem = ticketKeyProblem(key);
    if (problem) return problem;
    if (!filePath) return 'A file path is required, e.g. report.pdf.';

    const located = await locateUpload(filePath, deps.workspaceFolders());
    if (located.kind === 'refused') return located.answer;
    let bytes: Buffer;
    try {
      bytes = await fs.promises.readFile(located.realPath);
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'EISDIR' ? `"${filePath}" is a folder, not a file.` : `"${filePath}" could not be read.`;
    }
    if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
      return `"${filePath}" is ${formatFileSize(bytes.byteLength)}, over the 25 MB limit, so it was not uploaded.`;
    }

    const filename = path.basename(located.realPath);
    return writeOnce(
      deps.recentWrites,
      fingerprint(UPLOAD_ATTACHMENT_TOOL, key, located.realPath),
      `Skipped: ${filename} was uploaded to ${key} within the last minute. Wait a minute to upload it again.`,
      markWritten => runJiraTool(deps, UPLOAD_ATTACHMENT_TOOL, `Could not upload ${filename} to ${key}`, async ({ ticketService }) => {
        await ticketService.uploadAttachment(key, filename, inferContentType(filename), bytes.toString('base64'));
        markWritten();
        deps.onDiag?.('info', 'Attachment uploaded', { sizeBytes: bytes.byteLength });
        return `Uploaded "${filename}" to ${key}.`;
      }),
    );
  },
});
