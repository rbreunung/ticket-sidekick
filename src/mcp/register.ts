import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import type { ConfigService } from '../services/ConfigService';
import { JiraApiClient } from '../jira/JiraApiClient';
import { logDiag } from '../utils/diagLog';
import type { LogLevel } from '../utils/diagTypes';
import { JIRA_TOOLS } from './jiraTools/catalog';
import type { JiraAccess, JiraToolDeps } from './jiraTools/jiraAccess';
import { evaluateNoProxy, loopbackBypassConfigured } from './proxyBypass';
import { copilotHome, buildReport, redact, scanForSecret, type ReportFacts } from './report';
import { McpServerController, type McpDefinition } from './serverController';
import { detectMcpApi, type McpApi } from './vscodeMcpTypes';

// VS Code glue for the extension's MCP server. The server runs exactly while 127.0.0.1 is in
// `http.noProxy`: it starts at activation when the entry is there, starts or stops when the entry
// is added or removed, and stops on deactivation. Without the entry the Copilot runtime may send
// its loopback requests, bearer header included, to a network proxy, so then nothing is offered
// and a notice explains the setting at every VS Code start. The extension never writes settings.
// Jira configuration is no start condition: the tools read it at every call.

export const MCP_PROVIDER_ID = 'ticket-sidekick.mcp';
export const MCP_SERVER_LABEL = 'Ticket Sidekick';
export const MCP_COMMANDS = {
  copyDiagnostics: 'ticket-sidekick.mcp.copyDiagnostics',
} as const;

const OPEN_SETTING_CHOICE = 'Open Setting';
const PROXY_NOTICE =
  'Ticket Sidekick: the Jira tools for Copilot chats need 127.0.0.1 in the http.noProxy setting, '
  + 'so that Copilot\'s requests to the extension on this computer do not go through your network proxy. '
  + 'Once you add it, the tools appear without a restart.';

let active: McpServerController<JiraToolDeps> | undefined;

function log(level: LogLevel, message: string, details?: Record<string, unknown>): void {
  logDiag('mcp', level, message, details);
}

async function getJira(configService: ConfigService): Promise<JiraAccess> {
  const config = await configService.getConfig();
  if (!configService.isConfigured(config)) return { configured: false, config };
  const client = new JiraApiClient({
    baseUrl: config.baseUrl,
    authType: config.authType,
    token: config.token,
    sprintBoardId: config.sprintBoardId,
    onDiag: (level, message, details) => logDiag('jira.apiClient', level, message, details),
  });
  return { configured: true, config, client };
}

function noProxySetting(): unknown {
  return vscode.workspace.getConfiguration('http').get<unknown>('noProxy');
}

function mcpAllowed(): boolean {
  return loopbackBypassConfigured(noProxySetting());
}

function extensionVersion(context: vscode.ExtensionContext): string {
  return String((context.extension?.packageJSON as { version?: string } | undefined)?.version ?? 'unknown');
}

function showProxyNotice(): void {
  void vscode.window.showInformationMessage(PROXY_NOTICE, OPEN_SETTING_CHOICE).then(choice => {
    if (choice === OPEN_SETTING_CHOICE) void vscode.commands.executeCommand('workbench.action.openSettings', 'http.noProxy');
  });
}

/**
 * Registers the diagnostics command and, when this VS Code has the MCP provider API, the provider
 * and the server lifecycle. Every registration happens before this returns; the returned promise
 * settles once the server started at activation (if it does) is listening.
 */
export function registerMcp(context: vscode.ExtensionContext, configService: ConfigService): Promise<void> {
  const mcp = detectMcpApi(vscode);
  let controller: McpServerController<JiraToolDeps> | undefined;

  context.subscriptions.push(vscode.commands.registerCommand(MCP_COMMANDS.copyDiagnostics, async () => {
    const text = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Ticket Sidekick: building the MCP diagnostics (searching for stored keys)…' },
      () => buildDiagnostics(context, configService, controller, mcp !== undefined),
    );
    await vscode.env.clipboard.writeText(text);
    void vscode.window.showInformationMessage('Ticket Sidekick: MCP diagnostics copied to the clipboard. They contain no keys or tokens.');
  }));

  if (!mcp) {
    log('info', 'MCP server not started: this VS Code has no MCP server provider API (VS Code 1.101 or later is needed)');
    return Promise.resolve();
  }

  const toolDeps: JiraToolDeps = {
    getJira: () => getJira(configService),
    onDiag: (level, message, details) => logDiag('mcp.tools', level, message, details),
  };
  const started = new McpServerController<JiraToolDeps>({
    tools: JIRA_TOOLS,
    toolDeps,
    serverInfo: { name: 'ticket-sidekick', version: extensionVersion(context) },
    isMcpAllowed: mcpAllowed,
    onDiag: log,
  });
  controller = started;
  active = started;

  const version = extensionVersion(context);
  const toDefinition = (api: McpApi, d: McpDefinition) =>
    new api.McpHttpServerDefinition(MCP_SERVER_LABEL, vscode.Uri.parse(d.url), { ...d.headers }, version);
  const changed = new vscode.EventEmitter<void>();
  context.subscriptions.push(
    changed,
    started.onDidChange(() => changed.fire()),
    mcp.registerMcpServerDefinitionProvider(MCP_PROVIDER_ID, {
      onDidChangeMcpServerDefinitions: changed.event,
      provideMcpServerDefinitions: () => {
        const definition = started.definition();
        return definition ? [toDefinition(mcp, definition)] : [];
      },
      // VS Code calls this just before it connects, so a client always gets the current port and
      // key, never those of an earlier start; while stopped it gets nothing.
      resolveMcpServerDefinition: () => {
        const definition = started.resolveDefinition();
        return definition ? toDefinition(mcp, definition) : undefined;
      },
    }),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (!e.affectsConfiguration('http.noProxy')) return undefined;
      return mcpAllowed() ? started.start('entry added') : started.stop('entry removed');
    }),
  );

  if (mcpAllowed()) return started.start('activation');
  log('info', 'MCP server not started: 127.0.0.1 is not in http.noProxy');
  showProxyNotice();
  return Promise.resolve();
}

export async function deactivateMcp(): Promise<void> {
  const controller = active;
  active = undefined;
  await controller?.stop('deactivate');
}

// ---------------------------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------------------------

/** The chat.mcp.* and sandbox settings, flattened to dotted keys. */
function chatSettings(): Record<string, unknown> {
  const flat: Record<string, unknown> = {};
  const walk = (value: unknown, prefix: string) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) walk(v, `${prefix}.${k}`);
    } else if (/sandbox|^chat\.mcp\./i.test(prefix)) {
      flat[prefix] = value;
    }
  };
  walk(JSON.parse(JSON.stringify(vscode.workspace.getConfiguration('chat'))), 'chat');
  return flat;
}

/** The VS Code logs root for this session (the folder named "logs" above the extension's log folder). */
function logsRoot(logPath: string): string {
  let dir = logPath;
  for (let i = 0; i < 6; i++) {
    if (path.basename(dir) === 'logs') return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.dirname(logPath);
}

async function buildDiagnostics(
  context: vscode.ExtensionContext,
  configService: ConfigService,
  controller: McpServerController<JiraToolDeps> | undefined,
  providerApiAvailable: boolean,
): Promise<string> {
  const key = controller?.currentKey();
  const roots = [
    copilotHome(process.env, os.homedir()),
    logsRoot(context.logUri.fsPath),
    path.dirname(context.globalStorageUri.fsPath),
    ...(context.storageUri ? [path.dirname(path.dirname(context.storageUri.fsPath))] : []),
  ];
  const keyScan = key ? await scanForSecret(roots, key, { maxFiles: 20000, maxFileBytes: 64 * 1024 * 1024 }) : undefined;

  const http = vscode.workspace.getConfiguration('http');
  const proxy = http.get<unknown>('proxy');
  const config = await configService.getConfig();
  const bitbucket = await configService.getBitbucketConfig();
  const facts: ReportFacts = {
    generatedAt: new Date().toISOString(),
    vscodeVersion: vscode.version,
    extensionVersion: extensionVersion(context),
    os: `${os.platform()} ${os.release()}`,
    providerApiAvailable,
    loopbackBypass: mcpAllowed(),
    server: controller?.snapshot(),
    proxy: {
      noProxy: evaluateNoProxy(noProxySetting()),
      proxySet: typeof proxy === 'string' && proxy.trim() !== '',
      proxySupport: String(http.get<string>('proxySupport') ?? 'override'),
    },
    jira: { configured: configService.isConfigured(config), authType: config.authType, tokenPresent: Boolean(config.token) },
    chatSettings: chatSettings(),
    keyScan,
  };
  return redact(buildReport(facts), [key ?? '', config.token ?? '', bitbucket.token ?? '']);
}
