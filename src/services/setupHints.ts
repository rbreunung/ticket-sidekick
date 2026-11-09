// The setup hint every surface answers with while Jira is not configured: the Agent Mode tools,
// the MCP tools and `@jira check`. Pure (vscode-free) and outside the participant layer, so the
// MCP server and the tools depend on it without depending on a chat participant.

import type { JiraConfig } from './ConfigService';

/**
 * Plain-text "Jira isn't configured" message naming the specific missing setting or setup
 * command — the same information @jira's chat handler's own not-configured messages give,
 * but without a trusted `MarkdownString` command link (a `LanguageModelToolResult`, unlike a
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
