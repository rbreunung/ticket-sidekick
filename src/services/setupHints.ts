// The setup hints the tools answer with while Jira or Bitbucket is not configured: the Jira tools
// and `/ts-jira check`, and the Bitbucket tools. Pure (vscode-free) and outside the participant
// layer, so the tools depend on them without depending on a chat participant.

import type { BitbucketConfig } from '../bitbucket/IBitbucketClient';
import type { JiraConfig } from './ConfigService';

/**
 * Plain-text "Jira isn't configured" message naming the specific missing setting or setup
 * command, without a trusted `MarkdownString` command link (a `LanguageModelToolResult`, unlike a
 * chat stream, can't carry one), so this doubles as both a tool result and plain chat text.
 */
export function buildJiraNotConfiguredMessage(config: Pick<JiraConfig, 'baseUrl' | 'token' | 'authType'>): string {
  if (!config.baseUrl) {
    return (
      'Jira base URL not configured. Add `ticketSidekick.jira.baseUrl` in VS Code settings ' +
      '(e.g. `https://jira.mycompany.com`), then set your credentials.'
    );
  }
  const setupLabel = config.authType === 'cloud'
    ? 'Ticket Sidekick: Configure Jira Cloud Credentials'
    : 'Ticket Sidekick: Set Jira Personal Access Token';
  return `Jira credentials not configured. Run "${setupLabel}" from the Command Palette.`;
}

/**
 * Plain-text "Bitbucket isn't configured" message naming the specific missing setting or
 * setup command — the Bitbucket equivalent of `buildJiraNotConfiguredMessage`.
 * No trusted `MarkdownString` command link (a `LanguageModelToolResult` can't carry one), so
 * this doubles as both a tool result and plain chat text.
 */
export function buildBitbucketNotConfiguredMessage(config: Pick<BitbucketConfig, 'authType' | 'baseUrl' | 'token'>): string {
  const setupLabel = config.authType === 'cloud'
    ? 'Ticket Sidekick: Configure Bitbucket Cloud Credentials'
    : 'Ticket Sidekick: Set Bitbucket Personal Access Token';
  if (config.authType === 'datacenter' && !config.baseUrl) {
    return (
      'Bitbucket base URL not configured. Add `ticketSidekick.bitbucket.baseUrl` in VS Code settings, ' +
      `then run "${setupLabel}" from the Command Palette.`
    );
  }
  return `Bitbucket credentials not configured. Run "${setupLabel}" from the Command Palette.`;
}
