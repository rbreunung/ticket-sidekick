import * as vscode from 'vscode';
import type { BitbucketAuthType, BitbucketConfig } from '../bitbucket/IBitbucketClient';

type AuthType = 'datacenter' | 'cloud';

export interface JiraConfig {
  baseUrl: string | undefined;
  authType: AuthType;
  showConnectionInfo: boolean;
  requiredFields: string[];
  additionalDisplayFields: string[];
  hiddenDisplayFields: string[];
  token: string | undefined;
}

export class ConfigService {
  private static readonly TOKEN_KEY = 'ticket-sidekick.token';
  private static readonly BITBUCKET_TOKEN_KEY = 'ticket-sidekick.bitbucket.token';
  private static readonly OUTLOOK_TOKEN_KEY = 'ticket-sidekick.outlook.token';

  constructor(private readonly context: vscode.ExtensionContext) {}

  async getConfig(): Promise<JiraConfig> {
    const config = vscode.workspace.getConfiguration('ticketSidekick');
    return {
      baseUrl: config.get<string>('jira.baseUrl'),
      authType: config.get<AuthType>('jira.authType') ?? 'datacenter',
      showConnectionInfo: config.get<boolean>('jira.showConnectionInfo') ?? false,
      requiredFields: config.get<string[]>('jira.requiredFields') ?? [],
      additionalDisplayFields: config.get<string[]>('jira.additionalDisplayFields') ?? [],
      hiddenDisplayFields: config.get<string[]>('jira.hiddenDisplayFields') ?? [],
      token: await this.context.secrets.get(ConfigService.TOKEN_KEY),
    };
  }

  async storeToken(token: string): Promise<void> {
    await this.context.secrets.store(ConfigService.TOKEN_KEY, token);
  }

  async getBitbucketConfig(): Promise<BitbucketConfig> {
    const config = vscode.workspace.getConfiguration('ticketSidekick');
    return {
      baseUrl: config.get<string>('bitbucket.baseUrl'),
      authType: config.get<BitbucketAuthType>('bitbucket.authType') ?? 'datacenter',
      token: await this.context.secrets.get(ConfigService.BITBUCKET_TOKEN_KEY),
      showConnectionInfo: config.get<boolean>('bitbucket.showConnectionInfo') ?? false,
      reviewInstructions: config.get<string>('bitbucket.reviewInstructions') || undefined,
    };
  }

  async storeBitbucketToken(token: string): Promise<void> {
    await this.context.secrets.store(ConfigService.BITBUCKET_TOKEN_KEY, token);
  }

  async getOutlookConfig(): Promise<{ folderId: string; emailListSize: number }> {
    const config = vscode.workspace.getConfiguration('ticketSidekick');
    return {
      folderId: config.get<string>('outlook.folderId') ?? '',
      emailListSize: config.get<number>('outlook.emailListSize') ?? 10,
    };
  }

  async saveOutlookFolderId(folderId: string): Promise<void> {
    await vscode.workspace.getConfiguration('ticketSidekick')
      .update('outlook.folderId', folderId, vscode.ConfigurationTarget.Global);
  }

  getOutlookAuthProvider(): string {
    return vscode.workspace.getConfiguration('ticketSidekick').get<string>('outlook.authProvider') ?? 'vscode-microsoft';
  }

  async getOutlookToken(): Promise<string | undefined> {
    return this.context.secrets.get(ConfigService.OUTLOOK_TOKEN_KEY);
  }

  async storeOutlookToken(token: string): Promise<void> {
    await this.context.secrets.store(ConfigService.OUTLOOK_TOKEN_KEY, token);
  }
}
