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

    vscode.commands.registerCommand('jira-copilot.showModels', async () => {
      const models = await vscode.lm.selectChatModels();
      if (models.length === 0) {
        vscode.window.showWarningMessage('No language models found. Install GitHub Copilot or an Ollama extension.');
        return;
      }
      const items = models.map((m) => ({
        label: m.name,
        description: `family: ${m.family}`,
        detail: `id: ${m.id}`,
        family: m.family,
      }));
      const picked = await vscode.window.showQuickPick(items, {
        title: 'Available Language Models — pick one to copy its family name',
        placeHolder: 'Select a model to see its family name for jiraCopilot.languageModelFamily',
      });
      if (picked) {
        await vscode.env.clipboard.writeText(picked.family);
        vscode.window.showInformationMessage(`Family "${picked.family}" copied. Paste it into jiraCopilot.languageModelFamily in settings.`);
      }
    }),
  );

  createParticipant(context, configService);
}

export function deactivate(): void {}
