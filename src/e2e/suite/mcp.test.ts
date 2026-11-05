import * as assert from 'assert';
import * as vscode from 'vscode';
import { buildJiraNotConfiguredMessage } from '../../participant/session/constraints';
import type { E2eTest } from './index';

// The extension's MCP server as VS Code's own MCP client sees it. runTest.ts puts 127.0.0.1 into
// `http.noProxy` of the throwaway profile, so the server starts at activation and the provider
// offers it. VS Code does not connect to an extension-provided server by itself outside a chat
// request, so the test starts it through VS Code's start command, which connects, lists the tools
// and registers them as language model tools. Extension-provided servers are trusted by default,
// and a read-only tool invoked outside a chat asks no confirmation, so nothing prompts.

const CHECK_CONNECTION_TOOL = 'jira_check_connection';
// The label register.ts gives the server definition. VS Code names an extension-provided server
// `<extension id in lower case>/<label>` and its tools `mcp_<server prefix>_<tool name>`.
const SERVER_LABEL = 'Ticket Sidekick';
const START_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 15_000;
const POLL_MS = 250;

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function hasMcpProviderApi(): boolean {
  return typeof (vscode.lm as unknown as Record<string, unknown>).registerMcpServerDefinitionProvider === 'function';
}

/** The check tool as VS Code's MCP client registered it (not an Agent Mode tool of the same name). */
function mcpCheckTool(): vscode.LanguageModelToolInformation | undefined {
  return vscode.lm.tools.find(t => t.name !== CHECK_CONNECTION_TOOL && t.name.endsWith(`_${CHECK_CONNECTION_TOOL}`));
}

export function mcpTests(extensionId: string): E2eTest[] {
  const serverId = `${extensionId.toLowerCase()}/${SERVER_LABEL}`;
  const noMcpApi = () => `VS Code ${vscode.version} has no MCP server provider API (1.101 or later is needed)`;
  let toolName: string | undefined;

  return [
    {
      name: 'VS Code\'s MCP client lists the check connection tool once it starts the server',
      fn: async () => {
        if (!hasMcpProviderApi()) return { skipped: noMcpApi() };
        // The provider announces its server shortly after activation; a start asked for before
        // VS Code knows the server does nothing, so ask again until the tool shows up.
        const deadline = Date.now() + START_TIMEOUT_MS;
        let nextStart = 0;
        while (!mcpCheckTool() && Date.now() < deadline) {
          if (Date.now() >= nextStart) {
            nextStart = Date.now() + 1000;
            await vscode.commands.executeCommand('workbench.mcp.startServer', serverId, { waitForLiveTools: true });
          }
          await sleep(POLL_MS);
        }
        const tool = mcpCheckTool();
        assert.ok(tool, `no MCP tool ending in _${CHECK_CONNECTION_TOOL} within ${START_TIMEOUT_MS / 1000} s of starting ${serverId}`);
        toolName = tool.name;
      },
    },
    {
      name: 'calling the check connection tool through VS Code returns the Jira setup hint',
      fn: async () => {
        if (!hasMcpProviderApi()) return { skipped: noMcpApi() };
        assert.ok(toolName, 'the check connection tool was not listed');
        const result = await vscode.lm.invokeTool(toolName, { input: {}, toolInvocationToken: undefined });
        const text = result.content
          .map(part => (part instanceof vscode.LanguageModelTextPart ? part.value : ''))
          .join('');
        // The throwaway profile has no Jira settings, so the base URL is what is missing.
        assert.strictEqual(text, buildJiraNotConfiguredMessage({ baseUrl: undefined, token: undefined, authType: 'datacenter' }));
      },
    },
    {
      name: 'removing 127.0.0.1 from http.noProxy removes the tool from VS Code',
      fn: async () => {
        if (!hasMcpProviderApi()) return { skipped: noMcpApi() };
        assert.ok(toolName, 'the check connection tool was not listed');
        await vscode.workspace.getConfiguration('http').update('noProxy', [], vscode.ConfigurationTarget.Global);
        const deadline = Date.now() + STOP_TIMEOUT_MS;
        while (vscode.lm.tools.some(t => t.name === toolName) && Date.now() < deadline) await sleep(POLL_MS);
        assert.ok(!vscode.lm.tools.some(t => t.name === toolName), `${toolName} still listed ${STOP_TIMEOUT_MS / 1000} s after the entry was removed`);
      },
    },
  ];
}
