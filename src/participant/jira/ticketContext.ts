import * as vscode from 'vscode';
import { execSync } from 'child_process';
import { extractTicketId } from '../../utils/branchParser';
import { extractLastTicketFromText } from '../sessionState';

export function getLastAssistantText(context: vscode.ChatContext): string {
  for (let i = context.history.length - 1; i >= 0; i--) {
    const turn = context.history[i];
    if (turn instanceof vscode.ChatResponseTurn) {
      return turn.response
        .map((p) => (p instanceof vscode.ChatResponseMarkdownPart ? p.value.value : ''))
        .join('');
    }
  }
  return '';
}

export function resolveTicketFromBranch(): string | null {
  try {
    const branch = execSync('git branch --show-current', { encoding: 'utf-8' }).trim();
    return extractTicketId(branch);
  } catch {
    return null;
  }
}

export async function resolveProjectKey(
  fromIntent: string | null,
  stream: vscode.ChatResponseStream,
): Promise<string | null> {
  if (fromIntent) return fromIntent;

  const defaultProject = vscode.workspace.getConfiguration('ticketSidekick').get<string>('jira.defaultProject') ?? '';
  if (defaultProject) return defaultProject;

  stream.markdown('_No project key found in your message or settings — opening input box…_\n\n');
  const entered = await vscode.window.showInputBox({
    prompt: 'Enter the Jira project key (e.g. VSJI)',
    placeHolder: 'PROJECT',
    ignoreFocusOut: true,
  });
  return entered ?? null;
}

export function parseLastTicketFromContext(context: vscode.ChatContext): string | null {
  for (let i = context.history.length - 1; i >= 0; i--) {
    const turn = context.history[i];
    if (turn instanceof vscode.ChatResponseTurn) {
      const text = turn.response
        .map((p) => (p instanceof vscode.ChatResponseMarkdownPart ? p.value.value : ''))
        .join('');
      const key = extractLastTicketFromText(text);
      if (key) return key;
    }
  }
  return null;
}
