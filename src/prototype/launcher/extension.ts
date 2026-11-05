// The canvas launcher: a small Copilot SDK extension the Copilot runtime loads from
// <Copilot home>/extensions/ticket-sidekick while the Ticket Sidekick prototype runs. It declares
// one canvas and, when opened, returns the URL of the ticket board that the Ticket Sidekick
// extension serves on 127.0.0.1. It holds no credentials: the port and canvas key come from the
// rendezvous file the extension wrote next to this file.
//
// Bundled by esbuild into a single ESM file (extension.mjs); it is not compiled by tsc.

import { joinSession, createCanvas } from '@github/copilot-sdk/extension';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { readEntries, isProcessAlive, LAUNCHER_LOG } from '../prototypeFolder';
import { selectWindow } from '../selectWindow';

const folder = path.dirname(fileURLToPath(import.meta.url));

function log(record: Record<string, unknown>): void {
  try {
    fs.appendFileSync(path.join(folder, LAUNCHER_LOG), JSON.stringify({ at: new Date().toISOString(), ...record }) + '\n', { mode: 0o600 });
  } catch {
    // Logging is best effort; a full disk must not break opening the canvas.
  }
}

await joinSession({
  canvases: [
    createCanvas({
      id: 'ticket-board',
      displayName: 'Ticket board',
      description: 'Unresolved Jira tickets of the default project; comments are previewed before they are posted. Provided by the Ticket Sidekick prototype.',
      open: async (ctx) => {
        const { entries } = await readEntries(folder);
        const choice = selectWindow(entries, ctx.session?.workingDirectory, isProcessAlive);
        if (choice.kind === 'selected') {
          log({ outcome: 'selected', pid: choice.entry.pid, reason: choice.reason, windows: entries.length });
          return {
            title: 'Ticket board',
            status: 'Served by Ticket Sidekick',
            url: `http://127.0.0.1:${choice.entry.port}/${choice.entry.canvasKey}/`,
          };
        }
        log({ outcome: choice.kind, windows: entries.length });
        return {
          title: 'Ticket board',
          status: choice.kind === 'ambiguous'
            ? 'Several VS Code windows run the Ticket Sidekick prototype; open the chat from the window whose folder you are working in.'
            : 'Ticket Sidekick prototype is not running. Run "Ticket Sidekick: Start prototype" in VS Code.',
        };
      },
    }),
  ],
});
