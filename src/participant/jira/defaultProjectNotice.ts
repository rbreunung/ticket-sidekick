import * as vscode from 'vscode';
import { ConfigService } from '../../services/ConfigService';
import { JiraApiClient } from '../../jira/JiraApiClient';
import { checkDefaultProject, defaultProjectWarning } from '../../services/defaultProjectCheck';
import { logDiag } from '../../utils/diagLog';

// Warns at start, and again after the setting changes, when ticketSidekick.jira.defaultProject is
// not a project key or names a project Jira does not have. The extension never changes the setting;
// the warning offers to open it.

const SETTING = 'ticketSidekick.jira.defaultProject';
/** Settings typed in the Settings editor arrive while typing; the check waits until typing stops. */
export const DEFAULT_PROJECT_CHECK_DELAY_MS = 1_500;

export async function runDefaultProjectCheck(configService: ConfigService): Promise<void> {
  const value = vscode.workspace.getConfiguration('ticketSidekick').get<string>('jira.defaultProject');
  const check = await checkDefaultProject(value, {
    isJiraConfigured: async () => configService.isConfigured(await configService.getConfig()),
    getProject: async key => {
      const config = await configService.getConfig();
      const client = new JiraApiClient({
        baseUrl: config.baseUrl!,
        authType: config.authType,
        token: config.token!,
        onDiag: (level, message, details) => logDiag('jira.apiClient', level, message, details),
      });
      return client.getProject(key);
    },
  });
  logDiag('jira.defaultProject', check.kind === 'malformed' || check.kind === 'not-found' ? 'warn' : 'info', `Default project check: ${check.kind}`, check);
  const warning = defaultProjectWarning(check);
  if (!warning) return;
  const choice = await vscode.window.showWarningMessage(warning, 'Open Setting');
  if (choice === 'Open Setting') await vscode.commands.executeCommand('workbench.action.openSettings', SETTING);
}

export function registerDefaultProjectCheck(context: vscode.ExtensionContext, configService: ConfigService): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = () => {
    runDefaultProjectCheck(configService).catch(err =>
      logDiag('jira.defaultProject', 'error', 'Default project check failed', { error: err instanceof Error ? err.message : String(err) }));
  };
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (!e.affectsConfiguration(SETTING)) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(run, DEFAULT_PROJECT_CHECK_DELAY_MS);
    }),
    { dispose: () => { if (timer) clearTimeout(timer); } },
  );
  run();
}
