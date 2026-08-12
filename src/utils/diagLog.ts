import * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;

/**
 * Lazy singleton — shared by every feature in the extension (both `@jira`
 * and `@bitbucket`), not just this one. Visible to the user via
 * `View → Output → "Ticket Sidekick"`.
 */
export function getOutputChannel(): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel('Ticket Sidekick');
  }
  return channel;
}

/**
 * Append a timestamped diagnostic line. `scope` is a short dotted tag (e.g.
 * `bitbucket.review`, `jira.create`) so entries from different features
 * stay distinguishable in the one shared channel. Any feature in either
 * participant should log through this rather than inventing its own output
 * channel or relying on the chat transcript alone — see `CLAUDE.md` →
 * "Diagnostics".
 */
export function logDiag(scope: string, message: string, details?: Record<string, unknown>): void {
  const timestamp = new Date().toISOString();
  const out = getOutputChannel();
  out.appendLine(`[${timestamp}] [${scope}] ${message}`);
  if (details) {
    out.appendLine(JSON.stringify(details));
  }
}
