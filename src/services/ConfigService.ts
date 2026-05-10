import * as vscode from 'vscode';

type AuthType = 'datacenter' | 'cloud';

export interface JiraConfig {
  baseUrl: string | undefined;
  authType: AuthType;
  requiredFields: string[];
  token: string | undefined;
}

export class ConfigService {
  private static readonly TOKEN_KEY = 'jira-copilot.token';

  constructor(private readonly context: vscode.ExtensionContext) {}

  async getConfig(): Promise<JiraConfig> {
    const config = vscode.workspace.getConfiguration('jiraCopilot');
    return {
      baseUrl: config.get<string>('baseUrl'),
      authType: config.get<AuthType>('authType') ?? 'datacenter',
      requiredFields: config.get<string[]>('requiredFields') ?? [],
      token: await this.context.secrets.get(ConfigService.TOKEN_KEY),
    };
  }

  async storeToken(token: string): Promise<void> {
    await this.context.secrets.store(ConfigService.TOKEN_KEY, token);
  }
}
