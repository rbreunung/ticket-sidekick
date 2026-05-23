import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { ConfigService } from './services/ConfigService';
import { createJiraParticipant } from './participant/JiraParticipant';
import { createBitbucketParticipant } from './participant/BitbucketParticipant';
import { readHandoverEmail, purgeStaleFiles } from './utils/handoverFolder';
import { generateOwaUserscript } from './utils/owaUserscript';
import type { HandoverEmail } from './participant/sessionState';

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

    vscode.commands.registerCommand('ticket-sidekick.setOutlookToken', async () => {
      const token = await vscode.window.showInputBox({
        prompt: 'Paste your Microsoft Graph access token (get one from https://developer.microsoft.com/en-us/graph/graph-explorer)',
        password: true,
        ignoreFocusOut: true,
        placeHolder: 'eyJ0eXAiOiJKV1Qi...',
      });
      if (token) {
        await configService.storeOutlookToken(token);
        vscode.window.showInformationMessage('Ticket Sidekick: Outlook access token saved. Note: tokens expire in ~1 hour.');
      }
    }),

    vscode.window.registerUriHandler({
      handleUri(uri: vscode.Uri) {
        if (uri.path === '/from-email') {
          const folder = new URLSearchParams(uri.query).get('folder') ?? '';
          if (folder) vscode.commands.executeCommand('ticket-sidekick.processHandoverEmail', folder);
        }
      },
    }),

    vscode.commands.registerCommand('ticket-sidekick.processHandoverEmail', async (subfolder: string) => {
      if (!subfolder || !/^\d+$/.test(subfolder)) {
        if (subfolder) vscode.window.showErrorMessage('Ticket Sidekick: Invalid handover folder name.');
        return;
      }
      const config = vscode.workspace.getConfiguration('ticketSidekick');
      const rawFolder = config.get<string>('email.handoverFolder', '').trim();
      const handoverFolder = rawFolder
        ? rawFolder.replace(/^~/, os.homedir())
        : path.join(os.homedir(), 'Downloads');

      await purgeStaleFiles(handoverFolder, 24 * 60 * 60 * 1000);

      const manifestPath = path.join(handoverFolder, `TicketSidekick-${subfolder}.json`);
      const deadline = Date.now() + 15_000;
      while (!fs.existsSync(manifestPath)) {
        if (Date.now() >= deadline) {
          vscode.window.showErrorMessage(
            `Ticket Sidekick: Timed out waiting for handover email. Expected: ${manifestPath}`,
          );
          return;
        }
        await new Promise(r => setTimeout(r, 500));
      }

      let email: HandoverEmail;
      try {
        email = await readHandoverEmail(handoverFolder, subfolder);
      } catch (err) {
        vscode.window.showErrorMessage(
          `Ticket Sidekick: Could not read handover email — ${err instanceof Error ? err.message : String(err)}`,
        );
        return;
      }

      if (email.stripFooter) {
        const modelFamily = config.get<string>('email.cleanupModel', 'gpt-4o-mini');
        try {
          const models = await vscode.lm.selectChatModels({ family: modelFamily });
          if (models.length > 0) {
            const msgs = [
              vscode.LanguageModelChatMessage.User(
                `Remove the corporate email footer, signature, and legal disclaimer from this email body. ` +
                `Return only the relevant content as markdown:\n\n${email.markdownBody}`,
              ),
            ];
            const cts = new vscode.CancellationTokenSource();
            try {
              const res = await models[0].sendRequest(msgs, {}, cts.token);
              let cleaned = '';
              for await (const chunk of res.text) cleaned += chunk;
              email = { ...email, markdownBody: cleaned.trim() };
            } finally {
              cts.dispose();
            }
          }
        } catch {
          // Footer cleanup failed — continue with original body
        }
      }

      await context.workspaceState.update('jira.handover.email', email);
      await vscode.commands.executeCommand('workbench.action.chat.open', { query: '@jira create from email' });
    }),

    vscode.commands.registerCommand('ticket-sidekick.exportOwaUserscript', async () => {
      const config = vscode.workspace.getConfiguration('ticketSidekick');
      const owaUrl = config.get<string>('outlook.owaUrl', 'https://outlook.office.com').trim() || 'https://outlook.office.com';
      const script = generateOwaUserscript({
        owaUrl,
        vscodeUriBase: 'vscode://RobertBreunung.ticket-sidekick',
      });
      const doc = await vscode.workspace.openTextDocument({ language: 'javascript', content: script });
      await vscode.window.showTextDocument(doc);
    }),

  );

  createJiraParticipant(context, configService);
  createBitbucketParticipant(context, configService);
}

export function deactivate(): void {}
