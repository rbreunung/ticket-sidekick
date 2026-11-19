import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { ConfigService } from '../services/ConfigService';
import { TicketService } from '../services/TicketService';
import { TemplateService } from '../templates/TemplateService';
import { createVeracodeDescriptor } from '../imports/veracode';
import { createWaltzDescriptor } from '../imports/waltz';
import { checkEmailBatchCaps, createEmailDescriptor } from '../imports/email';
import { parseEmlFile } from '../utils/emlParser';
import { resolveBoilerplatePatterns } from '../utils/emailBoilerplate';
import { EMAIL_MODEL_SETTING, REVIEW_MODEL_SETTING, modelHandle, type BoardChatMessage, type BoardModels, type ModelSettings } from './boardModels';
import { emailSettings, veracodeSettings, waltzSettings } from '../services/importSettings';
import { registerKind } from '../sessions/boardKind';
import { SessionManager } from '../sessions/sessionManager';
import { SessionStore } from '../sessions/sessionStore';
import { logDiag } from '../utils/diagLog';
import { localDate } from '../utils/securityOverview';
import { resolveCsvDelimiter } from '../utils/securityOverviewCsv';
import type { JiraAccess } from '../tools/jiraTools/jiraAccess';
import { SESSIONS_BOARD } from './boardMessages';
import { BOARD_VIEW_TYPE, BoardPanels } from './boardPanels';
import { importKind } from './import/kind';
import { importJiraDeps } from './import/jiraDeps';
import type { ImportDescriptors } from './import/read';
import { IMPORT_KIND, type ReportKind } from './import/recipe';
import { IMPORT_START_BOARD, ImportStartScreen, reportReaderOf, type ReportReader } from './import/startScreen';
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
  importBoard: 'ticket-sidekick.openImportBoard',
} as const;

const DEFAULT_RETENTION_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

/** `ticketSidekick.sessions.retentionDays`: whole days from 1 to 365, else the default. */
export function retentionDays(): number {
  const value = vscode.workspace.getConfiguration('ticketSidekick').get<unknown>('sessions.retentionDays');
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 365 ? value : DEFAULT_RETENTION_DAYS;
}

/** The Veracode, Waltz and email descriptors over the settings, shared by the start screen and the import board. */
function importDescriptors(workspaceFolder: () => string | undefined, log: (level: 'info' | 'warn' | 'error', message: string, details?: Record<string, unknown>) => void): ImportDescriptors {
  return {
    veracode: createVeracodeDescriptor(veracodeSettings, { reviewColumns: [], onDiag: log }),
    waltz: createWaltzDescriptor(waltzSettings(workspaceFolder), { reviewColumns: [], onDiag: log }),
    email: createEmailDescriptor(emailSettings, { onDiag: log }),
  };
}

/** The models a board calls, over VS Code's language model API: no chat request is needed. */
export function vscodeBoardModels(justification: string): BoardModels {
  return {
    list: async () => (await vscode.lm.selectChatModels()).map(m => ({ id: m.id, name: m.name, vendor: m.vendor, family: m.family })),
    send: async (id, prompt) => {
      const [model] = await vscode.lm.selectChatModels({ id });
      if (!model) throw new Error(`The model ${id} is not available.`);
      // No caller cancels a board's call; the token is only required by the API.
      const source = new vscode.CancellationTokenSource();
      try {
        const response = await model.sendRequest([vscode.LanguageModelChatMessage.User(prompt)], { justification }, source.token);
        let text = '';
        for await (const chunk of response.text) text += chunk;
        return text;
      } finally {
        source.dispose();
      }
    },
    handle: async id => {
      const [model] = await vscode.lm.selectChatModels({ id });
      if (!model) {
        logDiag('boards.models', 'warn', 'The model a board asked for is not available', { modelId: id });
        return undefined;
      }
      return modelHandle({
        id: model.id,
        maxInputTokens: model.maxInputTokens,
        countTokens: text => model.countTokens(typeof text === 'string' ? text : chatMessage(text)),
        sendRequest: (messages, token) => model.sendRequest(messages.map(chatMessage), { justification }, token),
      }, () => new vscode.CancellationTokenSource());
    },
  };
}

function chatMessage(message: BoardChatMessage): vscode.LanguageModelChatMessage {
  return message.role === 'assistant'
    ? vscode.LanguageModelChatMessage.Assistant(message.content)
    : vscode.LanguageModelChatMessage.User(message.content);
}

/** The email check's and the review's model settings; a pick is saved for the user, since models belong to the user, not the workspace. */
export function vscodeModelSettings(): ModelSettings {
  const read = (key: string) => {
    const value = vscode.workspace.getConfiguration().get<unknown>(key);
    return typeof value === 'string' ? value : '';
  };
  return {
    emailModel: () => read(EMAIL_MODEL_SETTING),
    reviewModel: () => read(REVIEW_MODEL_SETTING),
    writeEmailModel: async id => { await vscode.workspace.getConfiguration().update(EMAIL_MODEL_SETTING, id, vscode.ConfigurationTarget.Global); },
    writeReviewModel: async id => { await vscode.workspace.getConfiguration().update(REVIEW_MODEL_SETTING, id, vscode.ConfigurationTarget.Global); },
  };
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
  const workspaceFolder = () => vscode.workspace.workspaceFolders?.find(f => f.uri.scheme === 'file')?.uri.fsPath;
  const ticketListDeps = ticketListJiraDeps({
    getJira,
    workspaceFolder,
    now: () => Date.now(),
    onDiag: log,
  });
  // One binding of the models and their settings, shared by the start screen and the email cleanup.
  const emailModels = vscodeBoardModels('Ticket Sidekick checks imported emails for boilerplate such as signatures and legal footers.');
  const modelSettings = vscodeModelSettings();
  const descriptors = importDescriptors(workspaceFolder, (level, message, details) => logDiag('boards.import', level, message, details));
  const importDeps = importJiraDeps({
    getJira,
    workspaceFolder,
    descriptors,
    now: () => Date.now(),
    csvDelimiter: () => resolveCsvDelimiter(vscode.workspace.getConfiguration('ticketSidekick').get('jira.overviewCsvDelimiter')),
    email: {
      boilerplatePatterns: () => resolveBoilerplatePatterns(
        vscode.workspace.getConfiguration('ticketSidekick').get<unknown>('email.boilerplatePatterns'),
        // An entry's phrases are email text: only the reason and the kind are logged.
        (reason, entry) => logDiag('boards.import', 'warn', `Ignored an invalid ticketSidekick.email.boilerplatePatterns entry — ${reason}`, {
          reason, kind: typeof entry === 'object' && entry !== null && typeof (entry as { kind?: unknown }).kind === 'string' ? (entry as { kind: string }).kind.slice(0, 20) : undefined,
        }),
      ),
      savePattern: async pattern => {
        const cfg = vscode.workspace.getConfiguration('ticketSidekick');
        const current = cfg.inspect<unknown>('email.boilerplatePatterns')?.globalValue;
        try {
          await cfg.update('email.boilerplatePatterns', [...(Array.isArray(current) ? current : []), pattern], vscode.ConfigurationTarget.Global);
        } catch (err) {
          // An error may echo the written value, whose phrases are email text.
          const message = err instanceof Error ? err.message : String(err);
          const phrases = [pattern.start, pattern.end].filter((p): p is string => !!p);
          throw new Error(phrases.reduce((m, p) => m.split(p).join('<pattern text>'), message));
        }
      },
      models: emailModels,
      modelSettings,
    },
    onDiag: (level, message, details) => logDiag('boards.import', level, message, details),
  });
  const kinds = [
    registerKind(securityReportKind, () => securityReportDeps),
    registerKind(ticketListKind, () => ticketListDeps),
    registerKind(importKind, () => importDeps),
  ];

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
  const configService = new ConfigService(context);
  const readers: Record<ReportKind, ReportReader> = {
    veracode: reportReaderOf(descriptors.veracode),
    waltz: reportReaderOf(descriptors.waltz),
    // The start screen reads email selections through `emailFiles`; this reader serves "Pick the file again".
    email: {
      read: async filePath => { const item = await parseEmlFile(filePath); return { items: [item], rawItems: [item] }; },
      noMatchMessage: 'No email could be read.',
      fileFilter: { label: 'Email', extensions: ['eml'] },
    },
  };
  /** VS Code's open dialog for a report of this kind, starting in Downloads. */
  const pickReportFile = async (filter: ReportReader['fileFilter']) => {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: { [filter.label]: filter.extensions },
      defaultUri: vscode.Uri.file(path.join(os.homedir(), 'Downloads')),
      title: `Select ${filter.label} (${filter.extensions.map(e => `.${e}`).join(', ')})`,
    });
    return uris?.[0]?.fsPath;
  };
  const importStart = new ImportStartScreen({
    jira: getJira,
    defaultProject: () => securityReportDeps.defaultProject(),
    templateSetting: kind => configService.getImportTemplate(kind),
    writeTemplateSetting: (kind, name) => configService.setImportTemplate(kind, name),
    writeDefaultProject: key => configService.setDefaultProject(key),
    templates: () => {
      const folder = workspaceFolder();
      return folder ? new TemplateService(folder).loadTemplates().templates : [];
    },
    reportReader: kind => readers[kind],
    pickReportFile: (_kind, filter) => pickReportFile(filter),
    pickEmailFiles: async () => {
      const uris = await vscode.window.showOpenDialog({
        canSelectMany: true,
        filters: { Email: ['eml'] },
        defaultUri: vscode.Uri.file(path.join(os.homedir(), 'Downloads')),
        title: 'Select .eml file(s) to import',
      });
      return uris?.map(uri => uri.fsPath);
    },
    emailFiles: {
      checkCaps: filePaths => checkEmailBatchCaps(filePaths, emailSettings.maxBatchBytes()),
      read: filePath => parseEmlFile(filePath),
    },
    models: emailModels,
    modelSettings,
    openSetting: async key => { await vscode.commands.executeCommand('workbench.action.openSettings', key); },
    // The stored list, not a lookup: looking a session up would start its background check.
    hasSession: async id => (await manager.list()).some(s => s.kind === IMPORT_KIND && s.id === id),
    discardSession: id => manager.discard(id),
    openImport: async recipe => {
      const opened = await panels.open(IMPORT_KIND, recipe);
      return opened.ok ? { ok: true, title: opened.title } : opened;
    },
    onDiag: (level, message, details) => logDiag('boards.importStart', level, message, details),
  });
  const panels = new BoardPanels(
    manager, kinds.map(k => k.kind.kind), pagesRoot, message => log('error', 'A board request failed', { error: message }), importStart,
    kind => pickReportFile(readers[kind].fileFilter),
  );
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
    vscode.commands.registerCommand(BOARD_COMMANDS.importBoard, () => openFromCommand(IMPORT_START_BOARD, {})),
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
