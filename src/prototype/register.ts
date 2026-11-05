import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { ConfigService } from '../services/ConfigService';
import { JiraApiClient } from '../jira/JiraApiClient';
import { TicketService } from '../services/TicketService';
import { buildJiraNotConfiguredMessage } from '../participant/sessionState';
import { logDiag } from '../utils/diagLog';
import { PrototypeController } from './prototypeController';
import { copilotHome, prototypeFolderPath, readEntries, isProcessAlive, LAUNCHER_LOG } from './prototypeFolder';
import { buildReport, redact, scanForSecret, type ReportFacts } from './report';
import { detectMcpApi } from './vscodeMcpTypes';
import type { JiraAccess } from './mcpEndpoint';

// VS Code glue for the Copilot harness prototype. Nothing starts on its own: each VS Code start
// shows one notification, and only "Start for this session" (or the Start command) turns the
// prototype on for this window. Nothing is stored in settings or extension state, and stopping or
// closing VS Code removes everything the prototype placed outside VS Code.

export const PROTOTYPE_COMMANDS = {
  start: 'ticket-sidekick.prototype.start',
  stop: 'ticket-sidekick.prototype.stop',
  copyReport: 'ticket-sidekick.prototype.copyReport',
  removeLeftovers: 'ticket-sidekick.prototype.removeLeftovers',
} as const;

const PROVIDER_ID = 'ticket-sidekick.prototype';
const SERVER_LABEL = 'Ticket Sidekick (prototype)';
const START_CHOICE = 'Start for this session';
const NOT_NOW_CHOICE = 'Not now';
const ADD_COMMENT_CHOICE = 'Add comment';

let active: PrototypeController | undefined;

function log(level: 'info' | 'warn' | 'error', message: string, details?: Record<string, unknown>): void {
  logDiag('prototype', level, message, details);
}

async function getJira(configService: ConfigService): Promise<JiraAccess> {
  const config = await configService.getConfig();
  if (!configService.isConfigured(config)) return { configured: false, message: buildJiraNotConfiguredMessage(config) };
  const client = new JiraApiClient({
    baseUrl: config.baseUrl,
    authType: config.authType,
    token: config.token,
    sprintBoardId: config.sprintBoardId,
    onDiag: (level, message, details) => logDiag('jira.apiClient', level, message, details),
  });
  const ticketService = new TicketService(client, (level, message, details) => logDiag('jira.ticketService', level, message, details));
  return { configured: true, ticketService, baseUrl: config.baseUrl };
}

async function confirmWrite(preview: string): Promise<boolean> {
  const choice = await vscode.window.showWarningMessage(
    'Ticket Sidekick prototype: the agent wants to write to Jira.',
    { modal: true, detail: preview },
    ADD_COMMENT_CHOICE,
  );
  return choice === ADD_COMMENT_CHOICE;
}

function workspaceFolderPaths(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
}

/** Both places a prototype folder may live: the current Copilot home and the default one. */
function candidatePrototypeFolders(): string[] {
  return [...new Set([
    prototypeFolderPath(copilotHome(process.env, os.homedir())),
    prototypeFolderPath(path.join(os.homedir(), '.copilot')),
  ])];
}

export function registerPrototype(context: vscode.ExtensionContext, configService: ConfigService): void {
  const mcp = detectMcpApi(vscode);
  const prototypeFolder = prototypeFolderPath(copilotHome(process.env, os.homedir()));
  const controller = new PrototypeController({
    getJira: () => getJira(configService),
    getProjectKey: () => vscode.workspace.getConfiguration('ticketSidekick').get<string>('jira.defaultProject') ?? '',
    confirmWrite,
    workspaceFolders: workspaceFolderPaths,
    launcherSourceDir: path.join(context.extensionPath, 'out', 'prototype-launcher'),
    prototypeFolder,
    pid: process.pid,
    onError: message => log('error', message),
  });
  active = controller;

  if (mcp) {
    const changed = new vscode.EventEmitter<void>();
    context.subscriptions.push(changed, controller.onDidChange(() => changed.fire()));
    context.subscriptions.push(mcp.registerMcpServerDefinitionProvider(PROVIDER_ID, {
      onDidChangeMcpServerDefinitions: changed.event,
      provideMcpServerDefinitions: () => {
        const definition = controller.mcpDefinition();
        return definition
          ? [new mcp.McpHttpServerDefinition(SERVER_LABEL, vscode.Uri.parse(definition.url), definition.headers, '0.0.1')]
          : [];
      },
      resolveMcpServerDefinition: server => (controller.isRunning() ? server : undefined),
    }));
  }

  const unsupported = () => vscode.window.showInformationMessage(
    'Ticket Sidekick prototype needs a VS Code version that supports MCP server registration (1.101 or later).',
  );

  const start = async () => {
    if (!mcp) { await unsupported(); return; }
    if (controller.isRunning()) {
      void vscode.window.showInformationMessage(`Ticket Sidekick prototype is already running on 127.0.0.1:${controller.port()}.`);
      return;
    }
    try {
      await controller.start();
      log('info', `Prototype started on 127.0.0.1:${controller.port()}`, { folder: prototypeFolder });
      const canvases = vscode.workspace.getConfiguration('chat').get<boolean>('canvases.enabled') === true;
      void vscode.window.showInformationMessage(
        `Ticket Sidekick prototype is running on 127.0.0.1:${controller.port()} for this VS Code session. ` +
        'Open a new chat, choose the Copilot harness in Session Target, and send a first message.' +
        (canvases ? '' : ' To try the ticket board, also turn on chat.canvases.enabled.'),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log('error', `Prototype could not start: ${message}`);
      void vscode.window.showErrorMessage(`Ticket Sidekick prototype could not start: ${message}`);
    }
  };

  context.subscriptions.push(
    vscode.commands.registerCommand(PROTOTYPE_COMMANDS.start, start),

    vscode.commands.registerCommand(PROTOTYPE_COMMANDS.stop, async () => {
      if (!controller.isRunning()) {
        void vscode.window.showInformationMessage('Ticket Sidekick prototype is not running in this window.');
        return;
      }
      const { folderRemoved } = await controller.stop();
      log('info', 'Prototype stopped', { folderRemoved });
      void vscode.window.showInformationMessage(
        folderRemoved
          ? 'Ticket Sidekick prototype stopped and its launcher folder was removed.'
          : 'Ticket Sidekick prototype stopped. Its launcher folder stays while another VS Code window still runs the prototype.',
      );
    }),

    vscode.commands.registerCommand(PROTOTYPE_COMMANDS.removeLeftovers, async () => {
      const removed = await controller.removeLeftovers(candidatePrototypeFolders());
      log('info', 'Prototype leftovers removed', { removed });
      void vscode.window.showInformationMessage(
        removed.length
          ? `Ticket Sidekick prototype removed: ${removed.join(', ')}`
          : 'Ticket Sidekick prototype: nothing to remove.',
      );
    }),

    vscode.commands.registerCommand(PROTOTYPE_COMMANDS.copyReport, async () => {
      const text = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Ticket Sidekick: building the prototype report (searching for stored keys)…' },
        () => buildPrototypeReport(context, configService, controller, Boolean(mcp), prototypeFolder),
      );
      await vscode.env.clipboard.writeText(text);
      void vscode.window.showInformationMessage('Ticket Sidekick prototype report copied to the clipboard. It contains no keys or tokens.');
    }),
  );

  if (mcp) {
    void vscode.window.showInformationMessage(
      'Ticket Sidekick prototype: start a key-protected server on 127.0.0.1 for this VS Code session? ' +
      'It lets Copilot-harness chats use Ticket Sidekick through MCP and serves the ticket board canvas. ' +
      'It stops when VS Code closes and nothing is remembered.',
      START_CHOICE,
      NOT_NOW_CHOICE,
    ).then(choice => {
      if (choice === START_CHOICE) void start();
    });
  }
}

export async function deactivatePrototype(): Promise<void> {
  const controller = active;
  active = undefined;
  await controller?.stop();
}

// ---------------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------------

function folderPermissions(folder: string): Promise<string> {
  if (!fs.existsSync(folder)) return Promise.resolve('(folder does not exist)');
  if (process.platform === 'win32') {
    return new Promise(resolve => {
      execFile('icacls', [folder], { timeout: 5000, windowsHide: true }, (err, stdout) => {
        resolve(err ? `(icacls failed: ${err.message})` : stdout.trim());
      });
    });
  }
  const mode = (p: string) => {
    try { return (fs.statSync(p).mode & 0o777).toString(8).padStart(3, '0'); } catch { return '(missing)'; }
  };
  return Promise.resolve(`folder ${mode(folder)}, rendezvous ${mode(path.join(folder, 'rendezvous'))}`);
}

function launcherLogTail(folder: string): string[] {
  try {
    return fs.readFileSync(path.join(folder, LAUNCHER_LOG), 'utf8').trim().split('\n').filter(Boolean).slice(-20);
  } catch {
    return [];
  }
}

function chatSettings(): Record<string, unknown> {
  const flat: Record<string, unknown> = {};
  const walk = (value: unknown, prefix: string) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) walk(v, `${prefix}.${k}`);
    } else if (/sandbox|canvas/i.test(prefix)) {
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

async function buildPrototypeReport(
  context: vscode.ExtensionContext,
  configService: ConfigService,
  controller: PrototypeController,
  providerApiAvailable: boolean,
  prototypeFolder: string,
): Promise<string> {
  const { entries, skipped } = await readEntries(prototypeFolder);
  const mcpKey = controller.mcpKey();
  const roots = [
    copilotHome(process.env, os.homedir()),
    logsRoot(context.logUri.fsPath),
    path.dirname(context.globalStorageUri.fsPath),
    ...(context.storageUri ? [path.dirname(path.dirname(context.storageUri.fsPath))] : []),
  ];
  const keyScan = mcpKey
    ? await scanForSecret(roots, mcpKey, { maxFiles: 20000, maxFileBytes: 64 * 1024 * 1024, skip: [prototypeFolder] })
    : undefined;

  const facts: ReportFacts = {
    generatedAt: new Date().toISOString(),
    vscodeVersion: vscode.version,
    extensionVersion: String((context.extension.packageJSON as { version?: string }).version ?? 'unknown'),
    os: `${os.platform()} ${os.release()}`,
    providerApiAvailable,
    running: controller.isRunning(),
    port: controller.port(),
    pid: process.pid,
    workspaceFolders: workspaceFolderPaths(),
    stats: controller.stats(),
    prototypeFolder,
    folderPermissions: await folderPermissions(prototypeFolder),
    entries: entries.map(e => ({ pid: e.pid, port: e.port, workspaceFolders: e.workspaceFolders, startedAt: e.startedAt, alive: isProcessAlive(e.pid) })),
    skippedEntries: skipped,
    launcherLog: launcherLogTail(prototypeFolder),
    chatSettings: chatSettings(),
    keyScan,
  };

  const config = await configService.getConfig();
  const bitbucket = await configService.getBitbucketConfig();
  const secrets = [
    ...controller.secrets(),
    ...entries.map(e => e.canvasKey),
    config.token ?? '',
    bitbucket.token ?? '',
  ];
  return redact(buildReport(facts), secrets);
}
