import * as vscode from 'vscode';
import * as path from 'path';
import { TicketService } from '../services/TicketService';
import { registerKind } from '../sessions/boardKind';
import { SessionManager } from '../sessions/sessionManager';
import { SessionStore } from '../sessions/sessionStore';
import { logDiag } from '../utils/diagLog';
import { localDate } from '../utils/securityOverview';
import { resolveCsvDelimiter } from '../utils/securityOverviewCsv';
import type { JiraAccess } from '../tools/jiraTools/jiraAccess';
import { SESSIONS_BOARD } from './boardMessages';
import { BOARD_VIEW_TYPE, BoardPanels } from './boardPanels';
import { SECURITY_REPORT_KIND, securityReportKind, type SecurityReportDeps } from './securityReport/kind';
import { ticketListJiraDeps } from './ticketList/jiraDeps';
import { checkCleanupRules, describeRuleProblem, type RuleProblem } from './ticketList/cleanupSource';
import { TICKET_LIST_KIND, ticketListKind } from './ticketList/kind';

// VS Code glue for the boards: where sessions are stored, the native confirmation and save dialog,
// the editor tabs, the retention setting and the commands. Everything it wires is free of `vscode`.

export const BOARD_COMMANDS = {
  clearSessions: 'ticket-sidekick.sessions.clear',
  securityReport: 'ticket-sidekick.boards.securityReport',
  ticketList: 'ticket-sidekick.boards.ticketList',
  cleanup: 'ticket-sidekick.boards.cleanup',
  sessions: 'ticket-sidekick.boards.sessions',
} as const;

const DEFAULT_RETENTION_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

/** `ticketSidekick.sessions.retentionDays`: whole days from 1 to 365, else the default. */
export function retentionDays(): number {
  const value = vscode.workspace.getConfiguration('ticketSidekick').get<unknown>('sessions.retentionDays');
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 365 ? value : DEFAULT_RETENTION_DAYS;
}

export interface RegisteredBoards {
  manager: SessionManager;
  panels: BoardPanels;
}

export function registerBoards(
  context: vscode.ExtensionContext,
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

  // The pages are plain files shipped with the extension and loaded by the tab itself.
  const pagesRoot = vscode.Uri.joinPath(context.extensionUri, 'out', 'board-pages');
  const panels = new BoardPanels(manager, kinds.map(k => k.kind.kind), pagesRoot, message => log('error', 'A board request failed', { error: message }));
  /** Opens a board from the Command Palette and says why when it cannot. */
  const openFromCommand = async (kind: string, input: unknown) => {
    const opened = await panels.open(kind, input);
    if (!opened.ok) void vscode.window.showWarningMessage(`Ticket Sidekick: the board was not opened: ${opened.reason}`);
  };

  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer(BOARD_VIEW_TYPE, panels.serializer()),
    vscode.commands.registerCommand(BOARD_COMMANDS.securityReport, async () => {
      const project = await vscode.window.showInputBox({
        title: 'Security report',
        prompt: 'Jira project key. Leave empty for the default project.',
        value: securityReportDeps.defaultProject(),
      });
      if (project !== undefined) await openFromCommand(SECURITY_REPORT_KIND, { project });
    }),
    vscode.commands.registerCommand(BOARD_COMMANDS.ticketList, async () => {
      const query = await vscode.window.showInputBox({
        title: 'Ticket list',
        prompt: 'A JQL query, or "filter:" followed by a saved filter\'s id or name.',
        placeHolder: 'assignee = currentUser() AND resolution is EMPTY',
      });
      if (!query?.trim()) return;
      const filter = /^filter:\s*(.+)$/i.exec(query.trim())?.[1];
      await openFromCommand(TICKET_LIST_KIND, filter ? { filter } : { jql: query.trim() });
    }),
    vscode.commands.registerCommand(BOARD_COMMANDS.cleanup, async () => {
      let rules: string[];
      let problems: RuleProblem[];
      try {
        const checked = checkCleanupRules(await ticketListDeps.cleanupRules());
        rules = checked.rules.map(rule => rule.name);
        problems = checked.problems;
      } catch (err) {
        void vscode.window.showWarningMessage(`Ticket Sidekick: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      if (problems.length > 0) {
        void vscode.window.showWarningMessage(`Ticket Sidekick: ${problems.map(describeRuleProblem).join('; ')}.`);
      }
      if (rules.length === 0) {
        if (problems.length === 0) void vscode.window.showInformationMessage('Ticket Sidekick: there are no cleanupRules in .jira-templates.json in this workspace.');
        return;
      }
      const rule = await vscode.window.showQuickPick(rules, { title: 'Cleanup', placeHolder: 'The cleanup rule to run' });
      if (!rule) return;
      const fixVersion = await vscode.window.showInputBox({
        title: `Cleanup: ${rule}`,
        prompt: 'A fix version in place of the rule\'s own: released, unreleased, a pattern with *, or a version name. Leave empty to use the rule as it is.',
      });
      if (fixVersion === undefined) return;
      await openFromCommand(TICKET_LIST_KIND, { cleanupRule: rule, ...(fixVersion.trim() ? { fixVersion: fixVersion.trim() } : {}) });
    }),
    vscode.commands.registerCommand(BOARD_COMMANDS.sessions, () => openFromCommand(SESSIONS_BOARD, {})),
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

  return { manager, panels };
}
