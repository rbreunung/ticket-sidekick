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
import { selectDefaultIssueType } from './participant/sessionState';
import type { EmailContentSession } from './participant/sessionState';
import { parseVeracodeReport, filterFlaws } from './utils/veracodeReport';
import type { VeracodeTemplateSelectionSession } from './participant/sessionState';
import { logDiag } from './utils/diagLog';

export function activate(context: vscode.ExtensionContext): void {
  const configService = new ConfigService(context);

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

      const availableTemplates: Array<{ name: string; issueType: string }> = (() => {
        if (!workspaceRoot) return [];
        try {
          return new TemplateService(workspaceRoot).loadTemplates().templates
            .map(t => ({ name: t.name, issueType: t.issueType ?? 'Story' }));
        } catch (err) {
          logDiag('extension', 'warn', 'Could not load templates — proceeding without', {
            error: err instanceof Error ? err.message : String(err),
          });
          return [];
        }
      })();

      const issueTypes = await jiraClient.getProject(projectKey)
        .then(p => p.issueTypes.filter(t => !t.subtask).map(t => t.name))
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          logDiag('extension', 'warn', `Could not fetch issue types — ${projectKey}`, { projectKey, error: message });
          vscode.window.showWarningMessage(
            `Ticket Sidekick: Could not fetch issue types for ${projectKey} — will default to 'Story'. ${message}`,
          );
          return [] as string[];
        });
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
    vscode.commands.registerCommand('ticket-sidekick.importVeracodeReport', async () => {
      const uris = await vscode.window.showOpenDialog({
        canSelectMany: false,
        filters: { 'Veracode report': ['xml'] },
        defaultUri: vscode.Uri.file(path.join(os.homedir(), 'Downloads')),
        title: 'Select Veracode Detailed Report (.xml)',
      });
      if (!uris || uris.length === 0) return;
      const reportPath = uris[0].fsPath;

      const MAX_REPORT_BYTES = 20 * 1024 * 1024;
      let raw: string;
      try {
        const stat = await fs.promises.stat(reportPath);
        if (stat.size > MAX_REPORT_BYTES) {
          vscode.window.showErrorMessage(`Ticket Sidekick: Report exceeds the ${MAX_REPORT_BYTES / (1024 * 1024)} MB size limit.`);
          return;
        }
        raw = await fs.promises.readFile(reportPath, 'utf-8');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logDiag('extension', 'error', `Could not read Veracode report — ${reportPath}`, { reportPath, error: message });
        vscode.window.showErrorMessage(`Ticket Sidekick: Could not read file: ${message}`);
        return;
      }

      const veracodeCfg = vscode.workspace.getConfiguration('ticketSidekick');
      let flaws;
      try {
        const allFlaws = parseVeracodeReport(raw);
        flaws = filterFlaws(allFlaws, {
          minSeverity: veracodeCfg.get<number>('veracode.minSeverity') ?? 4,
          includeStatuses: veracodeCfg.get<string[]>('veracode.includeRemediationStatuses') ?? ['New', 'Open', 'Reopened'],
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logDiag('extension', 'error', `Could not parse Veracode report — ${reportPath}`, { reportPath, error: message });
        vscode.window.showErrorMessage(`Ticket Sidekick: Could not parse Veracode report: ${message}`);
        return;
      }

      if (flaws.length === 0) {
        vscode.window.showInformationMessage(
          'Ticket Sidekick: No flaws in this report matched your current severity/status filters ' +
          '(ticketSidekick.veracode.minSeverity / ticketSidekick.veracode.includeRemediationStatuses).',
        );
        return;
      }

      const config = await configService.getConfig();
      if (!config.baseUrl || !config.token) {
        vscode.window.showErrorMessage('Ticket Sidekick: Configure Jira credentials first.');
        return;
      }

      let projectKey = veracodeCfg.get<string>('jira.defaultProject') ?? '';
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
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';

      const availableTemplates: Array<{ name: string; issueType: string }> = (() => {
        if (!workspaceRoot) return [];
        try {
          return new TemplateService(workspaceRoot).loadTemplates().templates
            .map(t => ({ name: t.name, issueType: t.issueType ?? 'Bug' }));
        } catch (err) {
          logDiag('extension', 'warn', 'Could not load templates — proceeding without', {
            error: err instanceof Error ? err.message : String(err),
          });
          return [];
        }
      })();

      const issueTypes = await jiraClient.getProject(projectKey)
        .then(p => p.issueTypes.filter(t => !t.subtask).map(t => t.name))
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          logDiag('extension', 'warn', `Could not fetch issue types — ${projectKey}`, { projectKey, error: message });
          vscode.window.showWarningMessage(
            `Ticket Sidekick: Could not fetch issue types for ${projectKey} — will default to 'Bug'. ${message}`,
          );
          return [] as string[];
        });

      const session: VeracodeTemplateSelectionSession = {
        reportFileName: path.basename(reportPath),
        projectKey,
        flaws,
        availableTemplates,
        availableIssueTypes: issueTypes.length > 0 ? issueTypes : ['Bug'],
      };

      await context.workspaceState.update('jira.session.veracodeTemplateSelection', session);
      await vscode.commands.executeCommand('workbench.action.chat.open', { query: '@jira import veracode report' });
    }),
  );

  createJiraParticipant(context, configService);
  createBitbucketParticipant(context, configService);
}

export function deactivate(): void {}
