import * as vscode from 'vscode';
import { ConfigService } from './services/ConfigService';
import { createBitbucketParticipant } from './participant/BitbucketParticipant';
import { registerBitbucketTools } from './tools/registerBitbucketTools';
import { registerJiraTools } from './tools/registerJiraTools';
import type { BoardStats } from './boards/boardPanels';
import { registerDefaultProjectCheck } from './services/defaultProjectNotice';

/** What `activate` returns: read only by the tests that drive a real VS Code. */
export interface TicketSidekickApi {
  boardStats(): BoardStats;
}

export function activate(context: vscode.ExtensionContext): TicketSidekickApi {
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
  );

  createBitbucketParticipant(context, configService);
  // The Jira tools for Copilot (language model tools) and the boards they open in editor tabs.
  const boards = registerJiraTools(context, configService);
  // The Bitbucket tools, which open and read the review board.
  registerBitbucketTools(context, configService, boards);
  // A wrong default project shows up at start and after the setting changes, not at first use.
  registerDefaultProjectCheck(context, configService);

  // KTD11: auto-open the Jira Getting-Started walkthrough once — on first install/first
  // activation only — guarded by a globalState "seen" flag so it never reopens on later VS Code
  // starts. Only the Jira walkthrough auto-opens (KTD10); the Bitbucket one (U7) is opt-in only.
  const JIRA_WALKTHROUGH_SEEN_KEY = 'ticketSidekick.jiraWalkthroughSeen';
  if (!context.globalState.get<boolean>(JIRA_WALKTHROUGH_SEEN_KEY)) {
    void context.globalState.update(JIRA_WALKTHROUGH_SEEN_KEY, true);
    void vscode.commands.executeCommand(
      'workbench.action.openWalkthrough',
      `${context.extension.id}#ticket-sidekick.jiraGettingStarted`,
      false,
    );
  }
  return { boardStats: () => boards.panels.stats() };
}

export function deactivate(): void {
  // Everything is disposed through context.subscriptions.
}
