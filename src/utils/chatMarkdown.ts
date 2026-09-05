import * as vscode from 'vscode';

/**
 * Wraps `text` in a `vscode.MarkdownString` trusted only for `workbench.action.chat.open` (KTD2/
 * KTD5) — the command every `buildChatCommandLink()` (`sessionState.ts`/`reviewSessionState.ts`)
 * link points at. Any response whose text was built with one or more of those links must pass
 * through this (or set the same `isTrusted` shape itself, matching the existing `settingsLink`/
 * `credentialsLink` pattern in `JiraParticipant.ts`) before reaching `stream.markdown(...)` —
 * `stream.markdown()` treats a plain string as untrusted, which renders a `command:` link as inert
 * plain text instead of a clickable command.
 */
export function trustedChatMarkdown(text: string): vscode.MarkdownString {
  const md = new vscode.MarkdownString(text);
  md.isTrusted = { enabledCommands: ['workbench.action.chat.open'] };
  return md;
}
