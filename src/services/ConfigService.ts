import * as vscode from 'vscode';
import type { BitbucketAuthType, BitbucketConfig } from '../bitbucket/IBitbucketClient';

type AuthType = 'datacenter' | 'cloud';

export interface JiraConfig {
  baseUrl: string | undefined;
  authType: AuthType;
  apiVersion: 2 | 3;
  showConnectionInfo: boolean;
  requiredFields: string[];
  token: string | undefined;
}

export class ConfigService {
  private static readonly TOKEN_KEY = 'ticket-sidekick.token';
  private static readonly BITBUCKET_TOKEN_KEY = 'ticket-sidekick.bitbucket.token';

  constructor(private readonly context: vscode.ExtensionContext) {}

  async getConfig(): Promise<JiraConfig> {
    const config = vscode.workspace.getConfiguration('ticketSidekick');
    return {
      baseUrl: config.get<string>('baseUrl'),
      authType: config.get<AuthType>('authType') ?? 'datacenter',
      apiVersion: config.get<2 | 3>('apiVersion') ?? 3,
      showConnectionInfo: config.get<boolean>('showConnectionInfo') ?? false,
      requiredFields: config.get<string[]>('requiredFields') ?? [],
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
    };
  }

  async storeBitbucketToken(token: string): Promise<void> {
    await this.context.secrets.store(ConfigService.BITBUCKET_TOKEN_KEY, token);
  }
}
