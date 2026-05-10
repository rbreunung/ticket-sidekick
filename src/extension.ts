import * as vscode from 'vscode';
import { ConfigService } from './services/ConfigService';
import { createParticipant } from './participant/JiraParticipant';

export function activate(context: vscode.ExtensionContext): void {
  const configService = new ConfigService(context);

  context.subscriptions.push(
    vscode.commands.registerCommand('jira-copilot.setDataCenterToken', async () => {
      const token = await vscode.window.showInputBox({
        prompt: 'Enter your Jira Personal Access Token',
        password: true,
        ignoreFocusOut: true,
      });
      if (token) {
        await configService.storeToken(token);
        vscode.window.showInformationMessage('Jira Copilot: Personal Access Token saved.');
      }
    }),

    vscode.commands.registerCommand('jira-copilot.configureCloud', async () => {
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
        vscode.window.showInformationMessage('Jira Copilot: Cloud credentials saved.');
      }
    }),

  );

  createParticipant(context, configService);
}

export function deactivate(): void {}
