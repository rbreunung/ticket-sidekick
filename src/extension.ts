import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { ConfigService } from './services/ConfigService';
import { createJiraParticipant } from './participant/JiraParticipant';
import { createBitbucketParticipant } from './participant/BitbucketParticipant';
import { parseEml, type ParsedEml } from './utils/emlParser';
import { htmlToMarkdown } from './utils/htmlToMarkdown';
import { JiraApiClient } from './jira/JiraApiClient';
import { TemplateService } from './templates/TemplateService';
import { selectDefaultIssueType, resolveTemplateIssueType } from './participant/sessionState';
import type { EmailContentSession } from './participant/sessionState';
import { parseVeracodeReport, filterFlaws } from './utils/veracodeReport';
import { buildVeracodeTemplateSession } from './participant/jira/veracodeHandler';
import { parseWaltzReport, filterComponents } from './utils/waltzReport';
import { buildWaltzTemplateSession } from './participant/jira/waltzHandler';
import { MAX_REPORT_BYTES } from './utils/reportImport';
import { readAndFilterReport } from './participant/jira/reportImportHandler';
import { logDiag } from './utils/diagLog';
import type { IJiraClient } from './jira/IJiraClient';
import { registerJiraTools } from './tools/jiraTools';

// Shared shape for the two nearly-identical report-import commands (Veracode .xml, Waltz OSS .xlsx):
// pick a file -> check credentials -> stat+size-cap+read+parse+filter -> empty-result message ->
// resolve project key -> build a JiraApiClient -> build the importer's template-selection session ->
// stash it in workspaceState and open chat. Everything the two commands do differently (file filter,
// which parser/filter to call, message text, which template-session builder to call) is supplied here.
interface ReportImportCommandDescriptor<TRaw, TItem> {
  reportKind: string; // 'Veracode' | 'OSS' — used in log scope details and the "Could not parse …" message
  fileFilterLabel: string;
  fileExtensions: string[];
  filePickerTitle: string;
  readContent: (filePath: string) => Promise<TRaw>;
  parse: (raw: TRaw) => TItem[] | Promise<TItem[]>;
  filter: (items: TItem[]) => TItem[];
  noMatchMessage: string;
  buildTemplateSession: (items: TItem[], fileName: string, projectKey: string, jiraClient: IJiraClient) => Promise<unknown>;
  sessionKey: string;
  chatQuery: string;
}

function registerReportImportCommand<TRaw, TItem>(
  context: vscode.ExtensionContext,
  configService: ConfigService,
  commandId: string,
  descriptor: ReportImportCommandDescriptor<TRaw, TItem>,
): vscode.Disposable {
  return vscode.commands.registerCommand(commandId, async () => {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: { [descriptor.fileFilterLabel]: descriptor.fileExtensions },
      defaultUri: vscode.Uri.file(path.join(os.homedir(), 'Downloads')),
      title: descriptor.filePickerTitle,
    });
    if (!uris || uris.length === 0) return;
    const reportPath = uris[0].fsPath;

    // Check credentials before paying for the file read/parse — no point loading up to 20 MB and
    // parsing it if Jira isn't even configured yet. This ordering was a deliberate fix earlier in
    // this refactor — keep credentials checked before any read/parse work happens.
    const config = await configService.getConfig();
    if (!config.baseUrl || !config.token) {
      vscode.window.showErrorMessage('Ticket Sidekick: Configure Jira credentials first.');
      return;
    }

    // readAndFilterReport() (reportImportHandler.ts) owns the stat+size-cap+read+parse+filter
    // sequence. Its own size-cap check happens before readContent is ever invoked, so if neither of
    // the two wrapped steps below reports itself as the failure point, the cap is the only thing left
    // that could have thrown — that's what lets the outer catch tell the two apart without string-
    // matching the thrown error. Preserves the three distinct pre-refactor messages (read failure /
    // parse failure / size-cap) exactly.
    let readOrParseFailed = false;
    let items: TItem[];
    try {
      items = await readAndFilterReport<TRaw, TItem>(
        reportPath,
        async filePath => {
          try {
            return await descriptor.readContent(filePath);
          } catch (err) {
            readOrParseFailed = true;
            const message = err instanceof Error ? err.message : String(err);
            logDiag('extension', 'error', `Could not read ${descriptor.reportKind} report — ${filePath}`, { reportPath: filePath, error: message });
            vscode.window.showErrorMessage(`Ticket Sidekick: Could not read file: ${message}`);
            throw err;
          }
        },
        async raw => {
          try {
            const parsed = await descriptor.parse(raw);
            return descriptor.filter(parsed);
          } catch (err) {
            readOrParseFailed = true;
            const message = err instanceof Error ? err.message : String(err);
            logDiag('extension', 'error', `Could not parse ${descriptor.reportKind} report — ${reportPath}`, { reportPath, error: message });
            vscode.window.showErrorMessage(`Ticket Sidekick: Could not parse ${descriptor.reportKind} report: ${message}`);
            throw err;
          }
        },
        // filter already applied above (inside the wrapped parse step, so parse+filter failures share
        // the same "Could not parse …" message exactly as before the refactor) — identity here.
        parsedItems => parsedItems,
      );
    } catch {
      if (!readOrParseFailed) {
        vscode.window.showErrorMessage(`Ticket Sidekick: Report exceeds the ${MAX_REPORT_BYTES / (1024 * 1024)} MB size limit.`);
      }
      return;
    }

    if (items.length === 0) {
      vscode.window.showInformationMessage(descriptor.noMatchMessage);
      return;
    }

    const cfg = vscode.workspace.getConfiguration('ticketSidekick');
    let projectKey = cfg.get<string>('jira.defaultProject') ?? '';
    if (!projectKey) {
      const entered = await vscode.window.showInputBox({
        prompt: 'Enter the Jira project key for the new tickets (e.g. PROJ)',
        placeHolder: 'PROJECT',
        ignoreFocusOut: true,
      });
      if (!entered) return;
      projectKey = entered;
    }

    const jiraClient = new JiraApiClient({
      baseUrl: config.baseUrl,
      authType: config.authType,
      token: config.token,
      onDiag: (level, message, details) => logDiag('jira.apiClient', level, message, details),
    });

    const session = await descriptor.buildTemplateSession(items, path.basename(reportPath), projectKey, jiraClient);

    await context.workspaceState.update(descriptor.sessionKey, session);
    await vscode.commands.executeCommand('workbench.action.chat.open', { query: descriptor.chatQuery });
  });
}

export function activate(context: vscode.ExtensionContext): void {
  const configService = new ConfigService(context);

  // Keeps `ticketSidekick.jiraCredentialsSet` / `ticketSidekick.bitbucketCredentialsSet` in
  // sync with the actual configured state — `when` clauses (later units: Getting-Started
  // walkthrough steps, tool availability) gate on these instead of re-deriving the check
  // themselves. Fires once at activation (so the very first window already has the right
  // value) and again on every secrets change (token set/cleared).
  const updateJiraContextKey = async (): Promise<void> => {
    const config = await configService.getConfig();
    await vscode.commands.executeCommand('setContext', 'ticketSidekick.jiraCredentialsSet', configService.isConfigured(config));
  };
  const updateBitbucketContextKey = async (): Promise<void> => {
    const config = await configService.getBitbucketConfig();
    await vscode.commands.executeCommand('setContext', 'ticketSidekick.bitbucketCredentialsSet', configService.isBitbucketConfigured(config));
  };
  context.subscriptions.push(
    context.secrets.onDidChange(async (e) => {
      if (e.key === 'ticket-sidekick.token') await updateJiraContextKey();
    }),
    context.secrets.onDidChange(async (e) => {
      if (e.key === 'ticket-sidekick.bitbucket.token') await updateBitbucketContextKey();
    }),
  );
  void updateJiraContextKey();
  void updateBitbucketContextKey();

  context.subscriptions.push(
    vscode.commands.registerCommand('ticket-sidekick.setDataCenterToken', async () => {
      const token = await vscode.window.showInputBox({
        prompt: 'Enter your Jira Personal Access Token',
        password: true,
        ignoreFocusOut: true,
      });
      if (token) {
        await configService.storeToken(token);
        vscode.window.showInformationMessage('Ticket Sidekick: Personal Access Token saved.');
      }
    }),

    vscode.commands.registerCommand('ticket-sidekick.configureCloud', async () => {
      const email = await vscode.window.showInputBox({
        prompt: 'Enter your Atlassian account email',
        ignoreFocusOut: true,
      });
      if (!email) return;
      const apiToken = await vscode.window.showInputBox({
        prompt: 'Enter your Atlassian API token (from id.atlassian.com)',
        password: true,
        ignoreFocusOut: true,
      });
      if (apiToken) {
        const encoded = Buffer.from(`${email}:${apiToken}`).toString('base64');
        await configService.storeToken(encoded);
        vscode.window.showInformationMessage('Ticket Sidekick: Cloud credentials saved.');
      }
    }),

    vscode.commands.registerCommand('ticket-sidekick.setBitbucketDataCenterToken', async () => {
      const token = await vscode.window.showInputBox({
        prompt: 'Enter your Bitbucket Personal Access Token',
        password: true,
        ignoreFocusOut: true,
      });
      if (token) {
        await configService.storeBitbucketToken(token);
        vscode.window.showInformationMessage('Ticket Sidekick: Bitbucket PAT saved.');
      }
    }),

    vscode.commands.registerCommand('ticket-sidekick.configureBitbucketCloud', async () => {
      const username = await vscode.window.showInputBox({
        prompt: 'Enter your Bitbucket Cloud username',
        ignoreFocusOut: true,
      });
      if (!username) return;
      const appPassword = await vscode.window.showInputBox({
        prompt: 'Enter your Bitbucket App Password (bitbucket.org → Personal settings → App passwords)',
        password: true,
        ignoreFocusOut: true,
      });
      if (appPassword) {
        const encoded = Buffer.from(`${username}:${appPassword}`).toString('base64');
        await configService.storeBitbucketToken(encoded);
        vscode.window.showInformationMessage('Ticket Sidekick: Bitbucket Cloud credentials saved.');
      }
    }),

    vscode.commands.registerCommand('ticket-sidekick.importEml', async () => {
      const uris = await vscode.window.showOpenDialog({
        canSelectMany: false,
        filters: { 'Email files': ['eml'] },
        defaultUri: vscode.Uri.file(path.join(os.homedir(), 'Downloads')),
        title: 'Select email (.eml) to import',
      });
      if (!uris || uris.length === 0) return;
      const emlPath = uris[0].fsPath;

      let buffer: Buffer;
      try {
        buffer = await fs.promises.readFile(emlPath);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logDiag('extension', 'error', `Could not read .eml file — ${emlPath}`, { emlPath, error: message });
        vscode.window.showErrorMessage(`Ticket Sidekick: Could not read file: ${message}`);
        return;
      }

      let parsed: ParsedEml;
      try {
        parsed = await parseEml(buffer);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logDiag('extension', 'error', `Could not parse .eml file — ${emlPath}`, { emlPath, error: message });
        vscode.window.showErrorMessage(`Ticket Sidekick: Could not parse email: ${message}`);
        return;
      }

      const config = await configService.getConfig();
      if (!config.baseUrl || !config.token) {
        vscode.window.showErrorMessage('Ticket Sidekick: Configure Jira credentials first.');
        return;
      }
      const projectKey = vscode.workspace.getConfiguration('ticketSidekick').get<string>('jira.defaultProject') ?? '';
      if (!projectKey) {
        vscode.window.showErrorMessage('Ticket Sidekick: Set ticketSidekick.jira.defaultProject in VS Code settings before importing email.');
        return;
      }

      const jiraClient = new JiraApiClient({
        baseUrl: config.baseUrl,
        authType: config.authType,
        token: config.token,
        onDiag: (level, message, details) => logDiag('jira.apiClient', level, message, details),
      });
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';

      const issueTypes = await jiraClient.getProject(projectKey)
        .then(p => p.issueTypes.filter(t => !t.subtask).map(t => t.name))
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          logDiag('extension', 'warn', `Could not fetch issue types — ${projectKey}`, { projectKey, error: message });
          vscode.window.showWarningMessage(
            `Ticket Sidekick: Could not fetch issue types for ${projectKey} — you'll be asked to type it. ${message}`,
          );
          return [] as string[];
        });

      const availableTemplates: Array<{ name: string; issueType: string }> = (() => {
        if (!workspaceRoot) return [];
        try {
          return new TemplateService(workspaceRoot).loadTemplates().templates
            .map(t => ({ name: t.name, issueType: resolveTemplateIssueType(t.issueType, issueTypes) }));
        } catch (err) {
          logDiag('extension', 'warn', 'Could not load templates — proceeding without', {
            error: err instanceof Error ? err.message : String(err),
          });
          return [];
        }
      })();

      const issueType = selectDefaultIssueType(issueTypes);

      const markdownBody = parsed.htmlBody
        ? htmlToMarkdown(parsed.htmlBody, parsed.inlineImageMap)
        : (parsed.plainBody ?? '');

      const inlineImageMap: Record<string, string> = {};
      for (const [k, v] of parsed.inlineImageMap) {
        inlineImageMap[k] = v;
      }

      const session: EmailContentSession = {
        emailId: 'eml-import',
        subject: parsed.subject,
        senderName: parsed.senderName,
        receivedDateTime: parsed.receivedDateTime,
        markdownBody,
        inlineImageMap,
        attachments: parsed.attachments.map(a => ({
          name: a.name,
          contentType: a.contentType,
          contentBytes: a.contentBytes,
          isInline: a.isInline,
        })),
        emlFilePath: emlPath,
        selectedTemplateName: null,
        projectKey,
        issueType,
        additionalFields: {},
        availableTemplates: availableTemplates.length > 0 ? availableTemplates : undefined,
        availableIssueTypes: issueTypes.length > 0 ? issueTypes : undefined,
      };

      await context.workspaceState.update('jira.session.emailContent', session);
      await vscode.commands.executeCommand('workbench.action.chat.open', { query: '@jira create from email' });
    }),
  );

  context.subscriptions.push(
    registerReportImportCommand(context, configService, 'ticket-sidekick.importVeracodeReport', {
      reportKind: 'Veracode',
      fileFilterLabel: 'Veracode report',
      fileExtensions: ['xml'],
      filePickerTitle: 'Select Veracode Detailed Report (.xml)',
      readContent: reportPath => fs.promises.readFile(reportPath, 'utf-8'),
      parse: raw => parseVeracodeReport(raw),
      filter: allFlaws => {
        const veracodeCfg = vscode.workspace.getConfiguration('ticketSidekick');
        return filterFlaws(allFlaws, {
          minSeverity: veracodeCfg.get<number>('veracode.minSeverity') ?? 4,
          includeStatuses: veracodeCfg.get<string[]>('veracode.includeRemediationStatuses') ?? ['New', 'Open', 'Reopened'],
        });
      },
      noMatchMessage:
        'Ticket Sidekick: No flaws in this report matched your current severity/status filters ' +
        '(ticketSidekick.veracode.minSeverity / ticketSidekick.veracode.includeRemediationStatuses).',
      buildTemplateSession: buildVeracodeTemplateSession,
      sessionKey: 'jira.session.veracodeTemplateSelection',
      chatQuery: '@jira import veracode report',
    }),
  );

  context.subscriptions.push(
    registerReportImportCommand(context, configService, 'ticket-sidekick.importWaltzReport', {
      reportKind: 'OSS',
      fileFilterLabel: 'OSS report',
      fileExtensions: ['xlsx'],
      filePickerTitle: 'Select OSS Report (.xlsx)',
      readContent: reportPath => fs.promises.readFile(reportPath),
      parse: raw => parseWaltzReport(raw),
      filter: allComponents => {
        const waltzCfg = vscode.workspace.getConfiguration('ticketSidekick');
        return filterComponents(allComponents, {
          minVulnRating: waltzCfg.get<string>('waltz.minVulnRating') ?? 'High',
          includeRemediationActions: waltzCfg.get<string[]>('waltz.includeRemediationActions') ?? ['', 'Remediate'],
        });
      },
      noMatchMessage:
        'Ticket Sidekick: No components in this report matched your current rating/remediation filters ' +
        '(ticketSidekick.waltz.minVulnRating / ticketSidekick.waltz.includeRemediationActions).',
      buildTemplateSession: buildWaltzTemplateSession,
      sessionKey: 'jira.session.waltzTemplateSelection',
      chatQuery: '@jira import oss report',
    }),
  );

  createJiraParticipant(context, configService);
  createBitbucketParticipant(context, configService);
  registerJiraTools(context, configService);
}

export function deactivate(): void {}
