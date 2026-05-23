import { execSync } from 'child_process';
import * as vscode from 'vscode';
import type { ConfigService } from '../services/ConfigService';

export type TokenProvider = () => Promise<string>;

const GRAPH_SCOPES = ['https://graph.microsoft.com/Mail.Read'];

function vscodeProvider(): TokenProvider {
  return async () => {
    const cached = await vscode.authentication.getSession('microsoft', GRAPH_SCOPES, { createIfNone: false, silent: true });
    if (cached) return cached.accessToken;

    let session: vscode.AuthenticationSession;
    try {
      session = await vscode.authentication.getSession('microsoft', GRAPH_SCOPES, { createIfNone: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('platform_broker_error')) {
        throw new Error(
          'Microsoft authentication failed (platform_broker_error). ' +
          'Fix: open VS Code Settings, search "microsoft-authentication enable platform", and uncheck "Enable Platform Auth". ' +
          'Or set `ticketSidekick.outlook.authProvider` to `azure-cli` if you have the Azure CLI installed.',
        );
      }
      if (msg.includes('AADSTS65002')) {
        throw new Error(
          'Corporate tenant blocked VS Code\'s Microsoft auth provider (AADSTS65002). ' +
          'Set `ticketSidekick.outlook.authProvider` to `azure-cli` (if `az` is installed and `az login` is done) ' +
          'or `token` (paste a token from Microsoft Graph Explorer).',
        );
      }
      throw err;
    }
    return session.accessToken;
  };
}

function azureCliProvider(): TokenProvider {
  return async () => {
    try {
      const result = execSync(
        'az account get-access-token --scope "https://graph.microsoft.com/Mail.Read" --query accessToken -o tsv',
        { encoding: 'utf8', timeout: 15_000 },
      ).trim();
      if (!result) throw new Error('az returned an empty token');
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('command not found') || msg.includes('not recognized') || msg.includes('ENOENT')) {
        throw new Error(
          'Azure CLI (`az`) not found. Install it from https://aka.ms/installazurecli, then run `az login`.',
        );
      }
      if (msg.includes('az login') || msg.includes('not logged in') || msg.includes('No subscription')) {
        throw new Error('Azure CLI is not logged in. Run `az login` in your terminal, then retry.');
      }
      throw new Error(`Azure CLI token fetch failed: ${msg}`);
    }
  };
}

function staticTokenProvider(configService: ConfigService): TokenProvider {
  return async () => {
    const token = await configService.getOutlookToken();
    if (!token) {
      throw new Error(
        'No Outlook access token stored. ' +
        'Run Command Palette → "Ticket Sidekick: Set Outlook Access Token" and paste a token from ' +
        'https://developer.microsoft.com/en-us/graph/graph-explorer — ' +
        'sign in, click "Modify permissions", add Mail.Read, consent, then copy the Access token. ' +
        'Note: tokens expire in ~1 hour.',
      );
    }
    return token;
  };
}

export function createOutlookTokenProvider(authProvider: string, configService: ConfigService): TokenProvider {
  switch (authProvider) {
    case 'azure-cli': return azureCliProvider();
    case 'token':     return staticTokenProvider(configService);
    default:          return vscodeProvider();
  }
}
