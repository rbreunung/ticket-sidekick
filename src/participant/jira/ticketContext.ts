import * as vscode from 'vscode';
import { execSync } from 'child_process';
import { extractTicketId } from '../../utils/branchParser';
import {
  extractLastTicketFromText, NO_ISSUE_TYPE, CURRENT_SESSION_SCHEMA_VERSION,
  type AwaitIssueTypeResume, type AwaitIssueTypeSession,
} from '../sessionState';

// workspaceState key + response tag for the shared issue-type chat-ask (R6/KTD4) — one session type
// shared by every flow that resolves an issue type before creating a ticket. See docs/jira-flows.md.
export const AWAIT_ISSUE_TYPE_SESSION_KEY = 'jira.session.awaitIssueType';
export const AWAIT_ISSUE_TYPE_TAG = '<!-- jira:await-issue-type -->';

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

// '' is the never-guess sentinel (see NO_ISSUE_TYPE in sessionState.ts) — detour to a chat-based
// ask (R6/KTD4) instead of ever creating a ticket with a guessed type, and instead of a native
// `showInputBox`. Shared by every flow that resolves an issue type before creating a ticket
// (create, email import, report import). Returns the resolved type when one was already known
// (synchronous continue — the caller proceeds in the same turn, unchanged from before); returns
// null when it detoured to chat (the caller must return without further work — resumption happens
// on a later turn via JiraParticipant.ts's shared router, using `resume` to get back to the right
// continuation). A caller that already treated null as "stop and return" needs no control-flow
// change, only the two new arguments.
export async function resolveIssueTypeOrPrompt(
  issueType: string,
  resume: AwaitIssueTypeResume,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
): Promise<string | null> {
  if (issueType !== NO_ISSUE_TYPE) return issueType;
  await streamAwaitIssueType({ resume, schemaVersion: CURRENT_SESSION_SCHEMA_VERSION }, stream, ws);
  return null;
}

export async function streamAwaitIssueType(
  session: AwaitIssueTypeSession,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
): Promise<void> {
  await ws.update(AWAIT_ISSUE_TYPE_SESSION_KEY, session);
  stream.markdown(
    `What issue type should this use (e.g. Bug, Story, Task)?\n\nReply with a type, or **(c)** to cancel.\n\n${AWAIT_ISSUE_TYPE_TAG}`,
  );
}

// A flow that clears its own workspaceState session before detouring to the chat-based issue-type
// ask (resolveIssueTypeOrPrompt above) opens a gap that now spans a whole extra chat turn: while
// the ask is pending, the user can start a second, independent run of the same command, which
// writes its own session to the same key. When the first ask's reply finally resumes, resuming
// with the closure-held session would act on stale data instead of noticing a newer run has since
// claimed the key. Call this on the resume path, right after the detour resolves and before doing
// any further work (template resolution, dedup search, ticket creation) — a superseded session
// must abort, not silently proceed.
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
