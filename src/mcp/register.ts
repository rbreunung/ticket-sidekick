import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import type { ConfigService } from '../services/ConfigService';
import { JiraApiClient } from '../jira/JiraApiClient';
import { logDiag } from '../utils/diagLog';
import type { LogLevel } from '../utils/diagTypes';
import { JIRA_TOOLS } from './jiraTools/catalog';
import { RecentCallGuard } from '../tools/recentCallGuard';
import type { JiraAccess, JiraToolDeps } from './jiraTools/jiraAccess';
import { evaluateNoProxy, loopbackBypassConfigured } from './proxyBypass';
import { buildReport, redact, scanForSecret, DEFAULT_SCAN_LIMITS, type ReportFacts } from './report';
import { McpServerController, type McpDefinition } from './serverController';
import { detectMcpApi, type McpApi } from './vscodeMcpTypes';
import { copilotHome } from '../utils/copilotHome';
import { windowNotesDir, WindowNoteKeeper } from '../canvas/windowNotes';
import { createCanvasHandler } from '../canvas/canvasRoutes';
import { openCheckRoute } from '../canvas/openCheck';
import { reportRoutes, type ThemeKind } from '../canvas/securityReport/reportApi';
import { PageStore } from '../canvas/securityReport/pageStore';
import { saveOverviewToFile } from '../participant/jira/overviewHandler';
import { canvasLogFile, readCanvasLog } from '../canvas/canvasLog';

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

/** How many of the canvas program's newest log lines the diagnostics report shows. */
const CANVAS_LOG_LINES = 20;

let active: McpServerController<JiraToolDeps> | undefined;
let activeNotes: WindowNoteKeeper | undefined;

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

function defaultProject(): string {
  return vscode.workspace.getConfiguration('ticketSidekick').get<string>('jira.defaultProject') ?? '';
}

/** The theme the canvas page takes, from VS Code's active color theme. */
function themeKind(): ThemeKind {
  switch (vscode.window.activeColorTheme?.kind) {
    case vscode.ColorThemeKind.Light: return 'light';
    case vscode.ColorThemeKind.HighContrast: return 'high-contrast';
    case vscode.ColorThemeKind.HighContrastLight: return 'high-contrast-light';
    default: return 'dark';
  }
}

/** The readings of this window's open security report pages; one store for the window's lifetime. */
const pageStore = new PageStore();

function noProxySetting(): unknown {
  return vscode.workspace.getConfiguration('http').get<unknown>('noProxy');
}

function mcpAllowed(): boolean {
  return loopbackBypassConfigured(noProxySetting());
}

function extensionVersion(context: vscode.ExtensionContext): string {
  return String((context.extension?.packageJSON as { version?: string } | undefined)?.version ?? 'unknown');
}

const CANVAS_NOTICE =
  'Ticket Sidekick: the security report opens as a canvas in Copilot chats, and canvases are off (chat.canvases.enabled). '
  + 'Turn the setting on to use it, where your organisation allows it.';

/** Shown at every start while canvases are off; the extension never changes the setting itself. */
function showCanvasNoticeIfOff(): void {
  if (vscode.workspace.getConfiguration('chat').get<unknown>('canvases.enabled') === true) return;
  void vscode.window.showInformationMessage(CANVAS_NOTICE, OPEN_SETTING_CHOICE).then(choice => {
    if (choice === OPEN_SETTING_CHOICE) void vscode.commands.executeCommand('workbench.action.openSettings', 'chat.canvases.enabled');
  });
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
    // Cancelling ends only the key search; the report is still built and copied, saying so.
    const text = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Ticket Sidekick: building the MCP diagnostics (searching for stored keys)…',
        cancellable: true,
      },
      (_progress, token) => buildDiagnostics(context, configService, controller, mcp !== undefined, () => token.isCancellationRequested),
    );
    await vscode.env.clipboard.writeText(text);
    void vscode.window.showInformationMessage('Ticket Sidekick: MCP diagnostics copied to the clipboard. They contain no keys or tokens.');
  }));

  if (!mcp) {
    log('info', 'MCP server not started: this VS Code has no MCP server provider API (VS Code 1.101 or later is needed)');
    return Promise.resolve();
  }

  // Only folders on this computer's disk: git, the template file and the workflow cache are read there.
  const localFolders = () => (vscode.workspace.workspaceFolders ?? []).filter(f => f.uri.scheme === 'file').map(f => f.uri.fsPath);
  showCanvasNoticeIfOff();

  const toolDeps: JiraToolDeps = {
    getJira: () => getJira(configService),
    workspaceFolders: localFolders,
    recentWrites: new RecentCallGuard(),
    onDiag: (level, message, details) => logDiag('mcp.tools', level, message, details),
  };
  const started = new McpServerController<JiraToolDeps>({
    tools: JIRA_TOOLS,
    toolDeps,
    serverInfo: { name: 'ticket-sidekick', version: extensionVersion(context) },
    isMcpAllowed: mcpAllowed,
    onCanvas: createCanvasHandler(
      [
        openCheckRoute({
          isJiraConfigured: async () => configService.isConfigured(await configService.getConfig()),
          defaultProject,
        }),
        ...reportRoutes({
          getJira: () => getJira(configService),
          defaultProject,
          themeKind,
          save: saveOverviewToFile,
          store: pageStore,
          onDiag: (level, message, details) => logDiag('canvas', level, message, details),
        }),
      ],
      message => logDiag('canvas', 'error', 'Canvas request failed', { error: message }),
      served => logDiag('canvas', served.status >= 400 ? 'warn' : 'info', `${served.method} ${served.path}: ${served.status}`, { ms: served.ms }),
    ),
    onDiag: log,
  });
  controller = started;
  active = started;
  // The note the canvas program reads to find this window's server: written while the server
  // runs, kept in step with the workspace folders, removed when the server stops.
  const notes = new WindowNoteKeeper({
    dir: windowNotesDir(copilotHome(process.env, os.homedir())),
    pid: process.pid,
    access: () => started.canvasAccess(),
    workspaceFolders: localFolders,
    onError: message => log('warn', 'Could not update the window note for canvases', { error: message }),
  });
  activeNotes = notes;

  const version = extensionVersion(context);
  const toDefinition = (api: McpApi, d: McpDefinition) =>
    new api.McpHttpServerDefinition(MCP_SERVER_LABEL, vscode.Uri.parse(d.url), { ...d.headers }, version);
  const changed = new vscode.EventEmitter<void>();
  context.subscriptions.push(
    changed,
    started.onDidChange(() => { changed.fire(); void notes.sync(); }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => { void notes.sync(); }),
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

  if (mcpAllowed()) return started.start('activation').then(() => notes.whenIdle());
  log('info', 'MCP server not started: 127.0.0.1 is not in http.noProxy');
  showProxyNotice();
  return Promise.resolve();
}

export async function deactivateMcp(): Promise<void> {
  const controller = active;
  const notes = activeNotes;
  active = undefined;
  activeNotes = undefined;
  await controller?.stop('deactivate');
  await notes?.remove();
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
  isCancelled: () => boolean,
): Promise<string> {
  const key = controller?.currentKey();
  const roots = [
    copilotHome(process.env, os.homedir()),
    logsRoot(context.logUri.fsPath),
    path.dirname(context.globalStorageUri.fsPath),
    ...(context.storageUri ? [path.dirname(path.dirname(context.storageUri.fsPath))] : []),
  ];
  const keyScan = key ? await scanForSecret(roots, key, DEFAULT_SCAN_LIMITS, isCancelled) : undefined;

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
    home: { dir: os.homedir(), windows: process.platform === 'win32' },
    canvasLog: await readCanvasLog(canvasLogFile(copilotHome(process.env, os.homedir())), CANVAS_LOG_LINES),
  };
  const canvasKey = controller?.canvasAccess()?.canvasKey;
  return redact(buildReport(facts), [key ?? '', canvasKey ?? '', config.token ?? '', bitbucket.token ?? '']);
}
