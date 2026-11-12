// The Ticket Sidekick canvas program: a small Copilot SDK extension that the extension ships as an
// agent plugin. The Copilot runtime runs it outside every VS Code window. It declares the board
// canvases and, when the agent opens one, finds the window whose workspace holds the chat's folder,
// asks it for the board's session and returns that window's page address. It holds no credentials
// and no board data: the port and canvas key come from the window notes, and everything a board
// shows is read and kept by the extension.
//
// Bundled by esbuild into one ESM file (extension.mjs); it is not compiled by tsc. The decisions it
// takes live in openDecision.ts and selectWindow.ts, where they are tested.

import { joinSession, createCanvas } from '@github/copilot-sdk/extension';
import * as http from 'http';
import * as os from 'os';
import { copilotHome } from '../../utils/copilotHome';
import { isProcessAlive, readNotes, windowNotesDir } from '../windowNotes';
import { selectWindow } from '../selectWindow';
import { asBoardOpenCheck, BOARD_CANVASES, openAnswer, type BoardOpenCheck } from '../openDecision';
import { repairRestoredCanvases } from '../restoreRepair';
import { BOARD_OPEN_PATH, BOARD_PING_PATH } from '../boardPaths';
import { appendCanvasLog, canvasLogFile } from '../canvasLog';

const home = copilotHome(process.env, os.homedir());
const notesDir = windowNotesDir(home);
const logFile = canvasLogFile(home);
const REQUEST_TIMEOUT_MS = 3_000;
declare const __TS_BUILD__: string | undefined;
const BUILD = typeof __TS_BUILD__ === 'string' ? __TS_BUILD__ : 'development';

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

async function askWindow(port: number, canvasKey: string, kind: string, input: unknown): Promise<BoardOpenCheck | undefined> {
  const query = `?kind=${encodeURIComponent(kind)}&input=${encodeURIComponent(JSON.stringify(input ?? {}))}`;
  try {
    const { status, body } = await getJson(port, `/${canvasKey}${BOARD_OPEN_PATH}${query}`);
    return status === 200 ? asBoardOpenCheck(body) : undefined;
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
    const { status } = await getJson(Number(parsed.port), `/${key}${BOARD_PING_PATH}`);
    return status === 200;
  } catch {
    return false;
  }
}

// Written before anything else, so the diagnostics report can tell a program that never started
// from one that started and could not join the chat session.
await appendCanvasLog(logFile, { event: 'program-start', node: process.version, canvases: BOARD_CANVASES.map(c => c.id).join(','), build: BUILD });

const session = await joinSession({
  canvases: BOARD_CANVASES.map(canvas => createCanvas({
    id: canvas.id,
    displayName: canvas.displayName,
    description: canvas.description,
    inputSchema: canvas.inputSchema as never,
    open: async ctx => {
      const { notes } = await readNotes(notesDir);
      const choice = selectWindow(notes, ctx.session?.workingDirectory, isProcessAlive);
      // The window validates the request and names the session; the agent gets only the status.
      const check = choice.kind === 'selected' ? await askWindow(choice.note.port, choice.note.canvasKey, canvas.id, ctx.input) : undefined;
      const answer = openAnswer(canvas, choice, check);
      await appendCanvasLog(logFile, {
        event: 'open',
        canvas: canvas.id,
        windows: notes.length,
        choice: choice.kind,
        check: check ? (check.ok ? 'ok' : 'refused') : 'none',
        opened: answer.url !== undefined,
      });
      return answer;
    },
  })),
}).then(
  async joined => {
    await appendCanvasLog(logFile, { event: 'joined' });
    return joined;
  },
  async (err: unknown) => {
    await appendCanvasLog(logFile, { event: 'join-failed', error: (err instanceof Error ? err.message : String(err)).split(/\r?\n/)[0].slice(0, 200) });
    throw err;
  },
);

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
