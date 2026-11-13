import * as assert from 'assert';
import * as vscode from 'vscode';
import type { E2eTest } from './index';

// A board opens as an editor tab and its page really loads from the extension's local server.
// Runs while the MCP server is up (127.0.0.1 is in http.noProxy of the throwaway profile), since
// the same server serves the board pages.

const LOAD_TIMEOUT_MS = 30_000;
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function boardTab(title: string): vscode.Tab | undefined {
  return vscode.window.tabGroups.all.flatMap(group => group.tabs).find(tab => tab.label === title && tab.input instanceof vscode.TabInputWebview);
}

/** The count of page requests the server answered, read from the diagnostics report. */
async function pageRequests(): Promise<number> {
  await vscode.commands.executeCommand('ticket-sidekick.mcp.copyDiagnostics');
  const report = await vscode.env.clipboard.readText();
  const match = /Canvas requests with a valid key: (\d+)/.exec(report);
  assert.ok(match, 'the diagnostics report has no line about page requests');
  return Number(match[1]);
}

export function boardTests(): E2eTest[] {
  return [
    {
      name: 'the stored sessions board opens as an editor tab from the Command Palette',
      fn: async () => {
        await vscode.commands.executeCommand('ticket-sidekick.boards.sessions');
        const deadline = Date.now() + LOAD_TIMEOUT_MS;
        while (!boardTab('Stored sessions') && Date.now() < deadline) await sleep(250);
        assert.ok(boardTab('Stored sessions'), 'no editor tab titled "Stored sessions" was opened');
      },
    },
    {
      name: 'the board\'s page loads from the local server inside that tab',
      fn: async () => {
        const deadline = Date.now() + LOAD_TIMEOUT_MS;
        let requests = 0;
        while (requests === 0 && Date.now() < deadline) {
          await sleep(1000);
          requests = await pageRequests();
        }
        assert.ok(requests > 0, 'the tab is open, but the local server received no request for the board page');
      },
    },
  ];
}
