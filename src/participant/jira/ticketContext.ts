import * as vscode from 'vscode';
import { execSync } from 'child_process';
import { extractTicketId } from '../../utils/branchParser';
import { extractLastTicketFromText, NO_ISSUE_TYPE } from '../sessionState';

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

// '' is the never-guess sentinel (see NO_ISSUE_TYPE in sessionState.ts) — detour to a free-type
// input box instead of ever creating a ticket with a guessed type. Shared by every flow that
// resolves an issue type before creating a ticket (create, email import, report import).
// Returns the resolved type, or null if the user cancelled (caller must not proceed on null).
export async function resolveIssueTypeOrPrompt(
  issueType: string,
  stream: vscode.ChatResponseStream,
): Promise<string | null> {
  if (issueType !== NO_ISSUE_TYPE) return issueType;
  const entered = await vscode.window.showInputBox({ prompt: 'Enter the issue type (e.g. Bug, Story, Task)', ignoreFocusOut: true }) ?? null;
  if (!entered) {
    stream.markdown('No issue type provided — cancelled.');
    return null;
  }
  return entered;
}

// A flow that clears its own workspaceState session before awaiting a free-type input box
// (resolveIssueTypeOrPrompt above) opens an async gap: while the native box sits open, the user
// can start a second, independent run of the same command, which writes its own session to the
// same key. When the first box finally resolves, resuming with the closure-held session would act
// on stale data instead of noticing a newer run has since claimed the key. Call this right after
// the detour resolves and before doing any further work (template resolution, dedup search,
// ticket creation) — a superseded session must abort, not silently proceed.
export function sessionWasSuperseded(ws: vscode.Memento, key: string): boolean {
  return ws.get(key) !== undefined;
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
