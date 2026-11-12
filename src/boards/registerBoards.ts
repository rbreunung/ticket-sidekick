import * as vscode from 'vscode';
import * as path from 'path';
import type { CanvasRoute } from '../canvas/canvasRoutes';
import type { ConfigService } from '../services/ConfigService';
import { TicketService } from '../services/TicketService';
import { registerKind } from '../sessions/boardKind';
import { SessionManager } from '../sessions/sessionManager';
import { SessionStore } from '../sessions/sessionStore';
import { logDiag } from '../utils/diagLog';
import { localDate } from '../utils/securityOverview';
import { resolveCsvDelimiter } from '../utils/securityOverviewCsv';
import type { JiraAccess } from '../mcp/jiraTools/jiraAccess';
import { boardRoutes } from './boardRoutes';
import { securityReportKind, type SecurityReportDeps } from './securityReport/kind';
import { ticketListJiraDeps } from './ticketList/jiraDeps';
import { ticketListKind } from './ticketList/kind';

// VS Code glue for the boards: where sessions are stored, the native confirmation and save dialog,
// the theme, the retention setting and the clear command. Everything it wires is free of `vscode`.

export const BOARD_COMMANDS = {
  clearSessions: 'ticket-sidekick.sessions.clear',
} as const;

const DEFAULT_RETENTION_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

/** `ticketSidekick.sessions.retentionDays`: whole days from 1 to 365, else the default. */
export function retentionDays(): number {
  const value = vscode.workspace.getConfiguration('ticketSidekick').get<unknown>('sessions.retentionDays');
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 365 ? value : DEFAULT_RETENTION_DAYS;
}

function themeKind(): 'light' | 'dark' | 'hc' {
  switch (vscode.window.activeColorTheme.kind) {
    case vscode.ColorThemeKind.Light: return 'light';
    case vscode.ColorThemeKind.HighContrast:
    case vscode.ColorThemeKind.HighContrastLight: return 'hc';
    default: return 'dark';
  }
}

export interface RegisteredBoards {
  manager: SessionManager;
  routes: CanvasRoute[];
}

export function registerBoards(
  context: vscode.ExtensionContext,
  configService: ConfigService,
  getJira: () => Promise<JiraAccess>,
): RegisteredBoards {
  const log = (level: 'info' | 'warn' | 'error', message: string, details?: Record<string, unknown>) => logDiag('boards', level, message, details);

  const securityReportDeps: SecurityReportDeps = {
    jira: async () => {
      const access = await getJira();
      if (!access.configured) return undefined;
      const ticketService = new TicketService(access.client, (level, message, details) => logDiag('jira.ticketService', level, message, details));
      return { ticketService, baseUrl: access.config.baseUrl };
    },
    defaultProject: () => vscode.workspace.getConfiguration('ticketSidekick').get<string>('jira.defaultProject') ?? '',
    csvDelimiter: () => resolveCsvDelimiter(vscode.workspace.getConfiguration('ticketSidekick').get('jira.overviewCsvDelimiter')),
    today: () => localDate(),
    now: () => Date.now(),
    onDiag: log,
  };
  const ticketListDeps = ticketListJiraDeps({
    getJira,
    workspaceFolder: () => vscode.workspace.workspaceFolders?.find(f => f.uri.scheme === 'file')?.uri.fsPath,
    now: () => Date.now(),
    onDiag: log,
  });
  const kinds = [registerKind(securityReportKind, () => securityReportDeps), registerKind(ticketListKind, () => ticketListDeps)];

  // Per workspace, outside the repository; the global folder only when no folder is open.
  const storeDir = path.join((context.storageUri ?? context.globalStorageUri).fsPath, 'sessions');
  const manager = new SessionManager({
    store: new SessionStore(storeDir),
    kinds,
    now: () => Date.now(),
    // A native dialog no page or script can accept: the gate for a risky board write.
    confirm: async plan => {
      const detail = plan.lines.map(line => `${line.target}: ${line.change}`).join('\n');
      return (await vscode.window.showWarningMessage(`Ticket Sidekick: ${plan.title}?`, { modal: true, detail }, 'Apply')) === 'Apply';
    },
    saveFile: async file => {
      const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
      const target = await vscode.window.showSaveDialog({
        defaultUri: folder ? vscode.Uri.joinPath(folder, file.fileName) : vscode.Uri.file(file.fileName),
        filters: { [file.filterName]: [file.extension] },
        saveLabel: 'Save',
      });
      if (!target) return false;
      await vscode.workspace.fs.writeFile(target, file.bytes);
      return true;
    },
    onDiag: log,
  });

  const expire = () => {
    void manager.expire(retentionDays()).then(
      removed => { if (removed > 0) log('info', 'Deleted stored sessions that were not used for the retention time', { removed }); },
      err => log('warn', 'Could not expire stored sessions', { error: err instanceof Error ? err.message : String(err) }),
    );
  };
  expire();
  const timer = setInterval(expire, DAY_MS);
  timer.unref?.();

  context.subscriptions.push(
    { dispose: () => clearInterval(timer) },
    vscode.commands.registerCommand(BOARD_COMMANDS.clearSessions, async () => {
      const choice = await vscode.window.showWarningMessage(
        'Ticket Sidekick: delete all stored sessions of this workspace?',
        { modal: true, detail: 'Unapplied choices on open boards are lost. Nothing in Jira or Bitbucket changes.' },
        'Delete',
      );
      if (choice !== 'Delete') return;
      const removed = await manager.discardAll();
      log('info', 'Stored sessions cleared', { removed });
      void vscode.window.showInformationMessage(`Ticket Sidekick: ${removed} stored session(s) deleted.`);
    }),
  );

  return {
    manager,
    routes: boardRoutes({
      manager,
      kinds: kinds.map(k => k.kind.kind),
      pagesDir: path.join(context.extensionPath, 'out', 'canvas-pages'),
      theme: themeKind,
    }),
  };
}
