import * as vscode from 'vscode';
import { execSync } from 'child_process';
import { extractTicketId } from '../../utils/branchParser';
import {
  extractLastTicketFromText, NO_ISSUE_TYPE, CURRENT_SESSION_SCHEMA_VERSION,
  type AwaitIssueTypeResume, type AwaitIssueTypeSession, type JiraSessionContinuity,
} from '../sessionState';

// workspaceState key for the shared issue-type chat-ask (R6/KTD4) — one session type shared by
// every flow that resolves an issue type before creating a ticket. See docs/jira-flows.md.
// U4: liveness is now detected via ChatResult.metadata (getActiveJiraSession), not a visible
// response tag — see JiraSessionContinuity in sessionState.ts.
export const AWAIT_ISSUE_TYPE_SESSION_KEY = 'jira.session.awaitIssueType';

// R1/R3: replaces the former `getLastAssistantText(...).includes('<!-- jira:TAG -->')` for sessions that
// have migrated off the visible-tag mechanism (see JiraSessionContinuity in sessionState.ts).
// Reads the metadata a session-producing response returned via `{ metadata: { jiraSession } }`
// off the last turn in `chatContext.history` — no rendered-text scanning, so no artifact of
// session-tracking is left in the chat transcript. Returns undefined when the last turn isn't a
// `ChatResponseTurn`, carries no result metadata, or the user has moved on since (a different,
// non-session response is now last) — matching today's "tag absent" behavior.
export function getActiveJiraSession(context: vscode.ChatContext): JiraSessionContinuity | undefined {
  const last = context.history[context.history.length - 1];
  if (!(last instanceof vscode.ChatResponseTurn)) return undefined;
  const metadata = last.result.metadata as { jiraSession?: JiraSessionContinuity } | undefined;
  return metadata?.jiraSession;
}

// U3: same metadata read as getActiveJiraSession, but for an arbitrary history turn rather than
// only the last one — used by llmHelpers.ts's extractHistoryTurns() to keep filtering
// session-management responses (e.g. 'previewing', 'load-skipped') out of LLM history context
// now that those turns carry no visible `<!-- jira:TAG -->` marker to text-match against (R3).
export function turnCarriesJiraSessionKind(
  turn: vscode.ChatRequestTurn | vscode.ChatResponseTurn,
  kind: JiraSessionContinuity['kinds'][number],
): boolean {
  if (!(turn instanceof vscode.ChatResponseTurn)) return false;
  const metadata = turn.result.metadata as { jiraSession?: JiraSessionContinuity } | undefined;
  return metadata?.jiraSession?.kinds.includes(kind) ?? false;
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
// Returns the resolved issue type string when one was already known (synchronous continue — the
// caller proceeds in the same turn, unchanged), or the `vscode.ChatResult` from the chat-based ask
// when it detoured (the caller must `return` it as-is so the metadata reaches the framework).
// Discriminate with `typeof result === 'string'` rather than a boolean/null sentinel, since
// `vscode.ChatResult` is itself an object, not `null`.
export async function resolveIssueTypeOrPrompt(
  issueType: string,
  resume: AwaitIssueTypeResume,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
): Promise<string | vscode.ChatResult> {
  if (issueType !== NO_ISSUE_TYPE) return issueType;
  return streamAwaitIssueType({ resume, schemaVersion: CURRENT_SESSION_SCHEMA_VERSION }, stream, ws);
}

export async function streamAwaitIssueType(
  session: AwaitIssueTypeSession,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
): Promise<vscode.ChatResult> {
  await ws.update(AWAIT_ISSUE_TYPE_SESSION_KEY, session);
  stream.markdown(
    `What issue type should this use (e.g. Bug, Story, Task)?\n\nReply with a type, or **(c)** to cancel.`,
  );
  return { metadata: { jiraSession: { kinds: ['await-issue-type'] } } };
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
