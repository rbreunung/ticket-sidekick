// The Ticket Sidekick canvas program: a small Copilot SDK extension that the extension ships as an
// agent plugin. The Copilot runtime runs it outside every VS Code window. It declares the security
// report canvas and, when the agent opens it, finds the window whose workspace holds the chat's
// folder and returns that window's page address. It holds no credentials: the port and canvas key
// come from the window notes, and the report itself is read from Jira by the extension.
//
// Bundled by esbuild into one ESM file (extension.mjs); it is not compiled by tsc. The decisions it
// takes live in openDecision.ts and selectWindow.ts, where they are tested.

import { joinSession, createCanvas } from '@github/copilot-sdk/extension';
import * as http from 'http';
import * as os from 'os';
import { copilotHome } from '../../utils/copilotHome';
import { isProcessAlive, readNotes, windowNotesDir } from '../windowNotes';
import { selectWindow } from '../selectWindow';
import { asOpenCheck, instanceIdFor, openAnswer, projectFromInput, SECURITY_REPORT_CANVAS_ID, type OpenCheck } from '../openDecision';
import { repairRestoredCanvases } from '../restoreRepair';
import { OPEN_CHECK_PATH } from '../openCheck';
import { appendCanvasLog, canvasLogFile } from '../canvasLog';

const home = copilotHome(process.env, os.homedir());
const notesDir = windowNotesDir(home);
const logFile = canvasLogFile(home);
const REQUEST_TIMEOUT_MS = 3_000;

/** A GET to a window's loopback server, straight to 127.0.0.1 and never through a proxy. */
function getJson(port: number, path: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', timeout: REQUEST_TIMEOUT_MS }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) });
        } catch {
          resolve({ status: res.statusCode ?? 0, body: undefined });
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

async function openCheck(port: number, canvasKey: string, project: string | undefined): Promise<OpenCheck | undefined> {
  const query = project ? `?project=${encodeURIComponent(project)}` : '';
  try {
    const { status, body } = await getJson(port, `/${canvasKey}${OPEN_CHECK_PATH}${query}`);
    return status === 200 ? asOpenCheck(body) : undefined;
  } catch {
    return undefined;
  }
}

/** Whether a canvas's saved address still reaches a running window (same port and canvas key). */
async function pageAnswers(url: string | undefined): Promise<boolean> {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    const key = parsed.pathname.split('/')[1] ?? '';
    const { status } = await getJson(Number(parsed.port), `/${key}${OPEN_CHECK_PATH}`);
    return status === 200;
  } catch {
    return false;
  }
}

const session = await joinSession({
  canvases: [
    createCanvas({
      id: SECURITY_REPORT_CANVAS_ID,
      displayName: 'Security report',
      description:
        'A project\'s open Veracode and Waltz security tickets by release, with Due Date flags, read from Jira by Ticket Sidekick '
        + 'and shown in its own tab, with filters and CSV or Excel export. Open it when the user asks for the security report. '
        + 'Pass the project key as input.project when the user names one. Use the instance id "security-report-<PROJECT>", '
        + 'or "security-report" when no project is named, so an open report is brought forward instead of opened twice.',
      inputSchema: {
        type: 'object',
        properties: { project: { type: 'string', description: 'The Jira project key, e.g. PROJ. Leave out to use the default project.' } },
        additionalProperties: false,
      },
      open: async ctx => {
        const project = projectFromInput(ctx.input);
        const { notes } = await readNotes(notesDir);
        const choice = selectWindow(notes, ctx.session?.workingDirectory, isProcessAlive);
        const check = choice.kind === 'selected' ? await openCheck(choice.note.port, choice.note.canvasKey, project) : undefined;
        const answer = openAnswer(choice, check);
        await appendCanvasLog(logFile, {
          event: 'open',
          windows: notes.length,
          choice: choice.kind,
          check: check ? (check.ok ? 'ok' : check.reason) : 'none',
          opened: answer.url !== undefined,
          expectedInstance: instanceIdFor(check?.ok ? check.project : project) === ctx.instanceId,
        });
        return answer;
      },
    }),
  ],
});

/** The chat's working folder, read once from the session; undefined when the runtime does not tell. */
let chatFolderRead: Promise<string | undefined> | undefined;
function chatFolder(): Promise<string | undefined> {
  chatFolderRead ??= session.rpc.metadata.snapshot().then(s => s.workingDirectory || undefined, () => undefined);
  return chatFolderRead;
}

void repairRestoredCanvases({
  listOpen: async () => (await session.rpc.canvas.listOpen()).openCanvases,
  reopen: canvas => session.rpc.canvas.open({ canvasId: canvas.canvasId, instanceId: canvas.instanceId, input: canvas.input as never }),
  close: async instanceId => { await session.rpc.canvas.close({ instanceId }); },
  pageAnswers,
  // Without the chat's folder, any running window lets the reopen try; the open request then
  // carries the folder and picks the window itself.
  chatWindowRunning: async () => {
    const { notes } = await readNotes(notesDir);
    const folder = await chatFolder();
    return folder ? selectWindow(notes, folder, isProcessAlive).kind === 'selected' : notes.some(n => isProcessAlive(n.pid));
  },
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  now: () => Date.now(),
  log: record => appendCanvasLog(logFile, record),
});
