import * as assert from 'assert';
import * as vscode from 'vscode';
import type { E2eTest } from './index';

// The Jira tools answer when VS Code calls them, and a board opens as an editor tab whose page
// really loads and talks to the extension over the webview's message channel. Nothing here needs
// Copilot, a proxy setting or a local server.

const LOAD_TIMEOUT_MS = 30_000;
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

interface BoardStats { openTabs: number; requestsAnswered: number }

function boardTab(title: string): vscode.Tab | undefined {
  return vscode.window.tabGroups.all.flatMap(group => group.tabs).find(tab => tab.label === title && tab.input instanceof vscode.TabInputWebview);
}

/** The text a language model tool answered with. */
function textOf(result: vscode.LanguageModelToolResult): string {
  return result.content.map(part => (part instanceof vscode.LanguageModelTextPart ? part.value : '')).join('');
}

export function boardTests(extensionId: string): E2eTest[] {
  const stats = (): BoardStats => (vscode.extensions.getExtension(extensionId)?.exports as { boardStats(): BoardStats }).boardStats();
  return [
    {
      name: 'a Jira tool answers when VS Code calls it',
      fn: async () => {
        const result = await vscode.lm.invokeTool('jira_check_connection', { input: {}, toolInvocationToken: undefined });
        assert.match(textOf(result), /token|base URL/i, 'the tool did not answer with the Jira setup hint');
      },
    },
    {
      name: 'the open board tool opens the stored sessions in an editor tab',
      fn: async () => {
        const result = await vscode.lm.invokeTool('jira_open_board', { input: { board: 'sessions' }, toolInvocationToken: undefined });
        assert.strictEqual(textOf(result), 'Opened in an editor tab: Stored sessions.');
        assert.ok(boardTab('Stored sessions'), 'the tool said it opened the board, but no such tab exists');
        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
      },
    },
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
      name: 'the board\'s page loads inside that tab and gets its answer from the extension',
      fn: async () => {
        // The page asks for the stored sessions as soon as its scripts ran, so an answered request
        // proves the document, its content policy, the scripts and the message channel all work.
        const before = stats().requestsAnswered;
        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
        await vscode.commands.executeCommand('ticket-sidekick.boards.sessions');
        const deadline = Date.now() + LOAD_TIMEOUT_MS;
        while (stats().requestsAnswered === before && Date.now() < deadline) await sleep(250);
        assert.ok(stats().requestsAnswered > before, 'the tab is open, but its page sent no request to the extension');
      },
    },
  ];
}
