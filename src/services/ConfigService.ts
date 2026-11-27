import * as vscode from 'vscode';
import type { BitbucketAuthType, BitbucketConfig } from '../bitbucket/IBitbucketClient';

type AuthType = 'datacenter' | 'cloud';

/** The report kinds whose import takes its template from a setting (`ticketSidekick.<kind>.template`). */
export type ImportTemplateKind = 'veracode' | 'waltz' | 'email';

export interface JiraConfig {
  baseUrl: string | undefined;
  authType: AuthType;
  requiredFields: string[];
  additionalDisplayFields: string[];
  hiddenDisplayFields: string[];
  searchFields: string[];
  cleanupFields: string[];
  /** Extra columns of the security report, the import board's Already ticketed tab and the overview exports. */
  securityReportFields: string[];
  token: string | undefined;
  sprintBoardId?: number;
  myTeamJql?: string;
}

export class ConfigService {
  private static readonly TOKEN_KEY = 'ticket-sidekick.token';
  private static readonly BITBUCKET_TOKEN_KEY = 'ticket-sidekick.bitbucket.token';

  constructor(private readonly context: vscode.ExtensionContext) {}

  async getConfig(): Promise<JiraConfig> {
    const config = vscode.workspace.getConfiguration('ticketSidekick');
    return {
      baseUrl: config.get<string>('jira.baseUrl'),
      authType: config.get<AuthType>('jira.authType') ?? 'datacenter',
      requiredFields: config.get<string[]>('jira.requiredFields') ?? [],
      additionalDisplayFields: config.get<string[]>('jira.additionalDisplayFields') ?? [],
      hiddenDisplayFields: config.get<string[]>('jira.hiddenDisplayFields') ?? [],
      searchFields: config.get<string[]>('jira.searchFields') ?? [],
      cleanupFields: config.get<string[]>('jira.cleanupFields') ?? [],
      securityReportFields: config.get<string[]>('jira.securityReportFields') ?? [],
      token: await this.context.secrets.get(ConfigService.TOKEN_KEY),
      sprintBoardId: config.get<number>('jira.sprintBoardId') || undefined,
      myTeamJql: config.get<string>('jira.myTeamJql') || undefined,
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
      reviewInstructions: config.get<string>('bitbucket.reviewInstructions') || undefined,
      modelContextTokens: config.get<number>('bitbucket.modelContextTokens') || undefined,
      contextBudgetRatio: config.get<number>('bitbucket.contextBudgetRatio') ?? 0.7,
      reviewExcludePatterns: config.get<string[]>('bitbucket.reviewExcludePatterns') ?? [],
      reviewContextLines: config.get<number>('bitbucket.reviewContextLines') ?? 12,
      confidenceThreshold: config.get<number>('bitbucket.confidenceThreshold') ?? 0.7,
      detailedDiagnostics: config.get<boolean>('bitbucket.detailedDiagnostics') ?? false,
    };
  }

  /** The template name an import of this report kind uses; empty when none is set. */
  getImportTemplate(kind: ImportTemplateKind): string {
    const value = vscode.workspace.getConfiguration('ticketSidekick').get<unknown>(`${kind}.template`);
    return typeof value === 'string' ? value.trim() : '';
  }

  /** Saves the template picked for this report kind: for the workspace when a folder is open, else for the user. */
  async setImportTemplate(kind: ImportTemplateKind, name: string): Promise<void> {
    const target = vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    await vscode.workspace.getConfiguration('ticketSidekick').update(`${kind}.template`, name, target);
  }

  /** Saves the project picked on the import start screen: for the workspace when a folder is open, else for the user. */
  async setDefaultProject(key: string): Promise<void> {
    const target = vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    await vscode.workspace.getConfiguration('ticketSidekick').update('jira.defaultProject', key, target);
  }

  async storeBitbucketToken(token: string): Promise<void> {
    await this.context.secrets.store(ConfigService.BITBUCKET_TOKEN_KEY, token);
  }

  /** A usable Jira connection needs both a base URL and a token, regardless of
   * DC vs Cloud (Cloud's token already encodes the Jira Cloud site via the account it's for).
   * A type predicate so call sites that go on to read `config.baseUrl`/`config.token` as plain
   * (non-optional) strings keep TypeScript's control-flow narrowing — same as the inline
   * `!config.baseUrl` / `!config.token` checks it replaces. */
  isConfigured(config: Pick<JiraConfig, 'baseUrl' | 'token'>): config is Pick<JiraConfig, 'baseUrl' | 'token'> & { baseUrl: string; token: string } {
    return !!(config.baseUrl && config.token);
  }

  /** Mirrors @bitbucket's existing Cloud-vs-DC asymmetry: Cloud talks to the fixed
   * api.bitbucket.org host and only needs a token, while Data Center additionally needs
   * a configured baseUrl. */
  isBitbucketConfigured(config: Pick<BitbucketConfig, 'authType' | 'baseUrl' | 'token'>): boolean {
    return config.authType === 'cloud' ? !!config.token : !!(config.baseUrl && config.token);
  }
}
