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
import type { EmailContentSession } from './participant/sessionState';

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
        vscode.window.showErrorMessage(`Ticket Sidekick: Could not read file: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }

      let parsed: ParsedEml;
      try {
        parsed = await parseEml(buffer);
      } catch (err) {
        vscode.window.showErrorMessage(`Ticket Sidekick: Could not parse email: ${err instanceof Error ? err.message : String(err)}`);
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

      const jiraClient = new JiraApiClient({ baseUrl: config.baseUrl, authType: config.authType, token: config.token });
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';

      const availableTemplates: Array<{ name: string; issueType: string }> = (() => {
        if (!workspaceRoot) return [];
        try {
          return new TemplateService(workspaceRoot).loadTemplates().templates
            .map(t => ({ name: t.name, issueType: t.issueType ?? 'Story' }));
        } catch { return []; }
      })();

      const issueTypes = await jiraClient.getProject(projectKey)
        .then(p => p.issueTypes.filter(t => !t.subtask).map(t => t.name))
        .catch((err: unknown) => {
          vscode.window.showWarningMessage(
            `Ticket Sidekick: Could not fetch issue types for ${projectKey} — will default to 'Story'. ${err instanceof Error ? err.message : String(err)}`,
          );
          return [] as string[];
        });
      const issueType = issueTypes.find(t => t === 'Story') ?? issueTypes.find(t => t === 'Task') ?? issueTypes[0] ?? 'Story';

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

  createJiraParticipant(context, configService);
  createBitbucketParticipant(context, configService);
}

export function deactivate(): void {}
