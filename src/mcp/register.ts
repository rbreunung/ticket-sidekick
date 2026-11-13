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
import { registerBoards } from '../boards/registerBoards';
import { canvasLogFile, readCanvasLog } from '../canvas/canvasLog';
import * as fs from 'fs';
import { checkOverHttp, checkOverSocket } from './selfCheck';
import { collectMcpLogLines } from './logTail';
import type { HostFacts } from './report';

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

declare const __TS_BUILD__: string | undefined;
/** The commit and time the bundle was built from, set by esbuild; "development" when run unbundled. */
const BUILD_ID = typeof __TS_BUILD__ === 'string' ? __TS_BUILD__ : 'development';

/** What VS Code asked of the provider since activation, for the diagnostics report. */
const providerCalls = { provide: 0, lastProvideAt: undefined as string | undefined, resolves: [] as string[] };
const MAX_RESOLVE_LINES = 10;
/** How many of VS Code's own log lines about MCP the diagnostics report shows. */
const VSCODE_LOG_LINES = 40;

/** A server name as VS Code compares it for collisions: letters and digits only, lower case. */
function plainName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** The MCP configuration files, of those given, that name a server like ours. */
async function filesNamingOurServer(files: string[]): Promise<string[]> {
  const ours = plainName(MCP_SERVER_LABEL);
  const found: string[] = [];
  for (const file of files) {
    try {
      const parsed = JSON.parse(await fs.promises.readFile(file, 'utf8')) as { servers?: Record<string, unknown>; mcpServers?: Record<string, unknown> };
      const names = [...Object.keys(parsed.servers ?? {}), ...Object.keys(parsed.mcpServers ?? {})];
      if (names.some(name => plainName(name) === ours)) found.push(file);
    } catch {
      // No such file, or not JSON: nothing to report.
    }
  }
  return found;
}

async function hostFacts(context: vscode.ExtensionContext, controller: McpServerController<JiraToolDeps> | undefined): Promise<HostFacts> {
  const folder = context.extensionPath;
  let otherCopies: string[] = [];
  try {
    const own = path.basename(folder);
    otherCopies = (await fs.promises.readdir(path.dirname(folder))).filter(name => /ticket-sidekick/i.test(name) && name !== own);
  } catch {
    // The parent folder cannot be listed: report none.
  }
  const port = controller?.port();
  const key = controller?.currentKey();
  const selfCheck = port !== undefined && key
    ? await Promise.all([checkOverSocket(port, key), checkOverHttp(port, key)]).then(([socket, viaHttp]) => ({
        socket: `${socket.outcome} in ${socket.ms} ms`, http: `${viaHttp.outcome} in ${viaHttp.ms} ms`,
      }))
    : undefined;
  const userDir = path.dirname(context.globalStorageUri.fsPath);
  const candidates = [
    path.join(path.dirname(userDir), 'mcp.json'),
    path.join(copilotHome(process.env, os.homedir()), 'mcp-config.json'),
    ...(vscode.workspace.workspaceFolders ?? []).filter(f => f.uri.scheme === 'file').flatMap(f => [
      path.join(f.uri.fsPath, '.vscode', 'mcp.json'), path.join(f.uri.fsPath, '.mcp.json'),
    ]),
  ];
  return {
    build: BUILD_ID,
    installFolder: folder,
    otherCopies,
    provideCalls: providerCalls.provide,
    lastProvideAt: providerCalls.lastProvideAt,
    resolveCalls: [...providerCalls.resolves],
    // VS Code lists a server's tools under names that end in the tool's own name.
    toolsListed: (vscode.lm?.tools ?? []).filter(tool => JIRA_TOOLS.some(t => tool.name === t.name || tool.name.endsWith(`_${t.name}`))).length,
    selfCheck,
    sameNameIn: await filesNamingOurServer(candidates),
    // The extension's log folder is <logs>/<session>/window<n>/exthost/<extension id>.
    vscodeLog: await collectMcpLogLines(path.dirname(path.dirname(context.logUri.fsPath)), VSCODE_LOG_LINES),
  };
}

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

  // Sessions, the board routes and the clear command exist whether or not the server can start.
  const boards = registerBoards(context, configService, () => getJira(configService));

  if (!mcp) {
    log('info', 'MCP server not started: this VS Code has no MCP server provider API (VS Code 1.101 or later is needed)');
    return Promise.resolve();
  }

  // Only folders on this computer's disk: git, the template file and the workflow cache are read there.
  const localFolders = () => (vscode.workspace.workspaceFolders ?? []).filter(f => f.uri.scheme === 'file').map(f => f.uri.fsPath);

  const toolDeps: JiraToolDeps = {
    getJira: () => getJira(configService),
    workspaceFolders: localFolders,
    recentWrites: new RecentCallGuard(),
    openBoard: (kind, input) => boards.panels.open(kind, input),
    onDiag: (level, message, details) => logDiag('mcp.tools', level, message, details),
  };
  const started = new McpServerController<JiraToolDeps>({
    tools: JIRA_TOOLS,
    toolDeps,
    serverInfo: { name: 'ticket-sidekick', version: extensionVersion(context) },
    isMcpAllowed: mcpAllowed,
    onCanvas: createCanvasHandler(
      boards.routes,
      message => logDiag('canvas', 'error', 'Canvas request failed', { error: message }),
      served => logDiag('canvas', served.status >= 400 ? 'warn' : 'info', `${served.method} ${served.path}: ${served.status}`, { ms: served.ms }),
    ),
    onDiag: log,
  });
  controller = started;
  active = started;
  boards.panels.setAccess(() => started.canvasAccess());
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

  // VS Code keeps a server's tools and state per definition version. A build installed from a file
  // has the version of the release it was branched from, so the commit is added: VS Code then sees
  // a new server and does not reuse what it kept for the other build.
  const commit = /^[0-9a-f]{7,}/.exec(BUILD_ID)?.[0];
  const version = commit ? `${extensionVersion(context)}+${commit}` : extensionVersion(context);
  const toDefinition = (api: McpApi, d: McpDefinition) =>
    new api.McpHttpServerDefinition(MCP_SERVER_LABEL, vscode.Uri.parse(d.url), { ...d.headers }, version);
  const changed = new vscode.EventEmitter<void>();
  context.subscriptions.push(
    changed,
    // A start gives the server a new port and key, so every open board tab is drawn again.
    started.onDidChange(() => { changed.fire(); void notes.sync(); boards.panels.refreshAll(); }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => { void notes.sync(); }),
    mcp.registerMcpServerDefinitionProvider(MCP_PROVIDER_ID, {
      onDidChangeMcpServerDefinitions: changed.event,
      provideMcpServerDefinitions: () => {
        const definition = started.definition();
        providerCalls.provide++;
        providerCalls.lastProvideAt = new Date().toISOString();
        log('info', `VS Code asked for the server definition (${definition ? 'one offered' : 'none offered'})`);
        return definition ? [toDefinition(mcp, definition)] : [];
      },
      // VS Code calls this just before it connects, so a client always gets the current port and
      // key, never those of an earlier start; while stopped it gets nothing.
      resolveMcpServerDefinition: (asked: { label?: string; uri?: { toString(): string } }) => {
        const definition = started.resolveDefinition();
        // The port VS Code held tells whether it was working from an earlier start's definition.
        const heldPort = /:(\d+)\//.exec(asked?.uri?.toString() ?? '')?.[1] ?? 'none';
        const line = `${new Date().toISOString()} for "${asked?.label ?? ''}" holding port ${heldPort}: ${definition ? `given port ${started.port()}` : 'refused, server stopped'}`;
        providerCalls.resolves.push(line);
        if (providerCalls.resolves.length > MAX_RESOLVE_LINES) providerCalls.resolves.shift();
        log('info', `VS Code asked to start the server: ${line}`);
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

/** The chat settings about MCP, plugins, canvases, the harness, managed customization and the sandbox, flattened to dotted keys. */
function chatSettings(): Record<string, unknown> {
  const flat: Record<string, unknown> = {};
  const walk = (value: unknown, prefix: string) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) walk(v, `${prefix}.${k}`);
    } else if (/sandbox|^chat\.mcp\.|mcp|plugin|managed|customization|canvas|harness/i.test(prefix)) {
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
    host: await hostFacts(context, controller),
  };
  const canvasKey = controller?.canvasAccess()?.canvasKey;
  return redact(buildReport(facts), [key ?? '', canvasKey ?? '', config.token ?? '', bitbucket.token ?? '']);
}
