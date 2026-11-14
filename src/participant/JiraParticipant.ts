import * as vscode from 'vscode';
import { JiraApiClient } from '../jira/JiraApiClient';
import type { ConfigService } from '../services/ConfigService';
import { TicketService } from '../services/TicketService';
import { logDiag } from '../utils/diagLog';
import { trustedChatMarkdown } from '../utils/chatMarkdown';
import type { ParsedIntent } from './jira/llmHelpers';
import { parseIntent } from './jira/llmHelpers';
import { getActiveJiraSession, AWAIT_ISSUE_TYPE_SESSION_KEY, STALE_RESOLUTION_SESSION_KEY } from './jira/ticketContext';
import {
  handleCreateFromEmail, handleAddEmailFromChat, handleEmailContentSession,
  handleEmailTemplateSelection, handleEmailReviewReply, handleEmailCleanupReply, handleEmailAwaitIssueType, EMAIL_CLEANUP_SESSION_KEY,
} from './jira/emailHandler';
import {
  handleImportVeracodeReport, handleVeracodeTemplateSelection, handleVeracodeReviewReply, handleVeracodeAwaitIssueType, handleVeracodeStaleClose,
} from './jira/veracodeHandler';
import {
  handleImportWaltzReport, handleWaltzTemplateSelection, handleWaltzReviewReply, handleWaltzAwaitIssueType, handleWaltzStaleClose,
} from './jira/waltzHandler';
import {
  isGreetingOrEmpty, buildJiraHelp, isSessionExpired, SESSION_EXPIRED_MESSAGE, parseAwaitFreeTextReply, buildChatCommandLink,
  JIRA_ONLY_IMPORTS_NOTICE,
  type AwaitIssueTypeSession, type StaleCloseSession, type JiraSessionKind,
  type EmailContentSession, type EmailTemplateSelectionSession, type EmailReviewSession, type EmailCleanupSession,
  type VeracodeTemplateSelectionSession, type VeracodeReviewSession,
  type WaltzTemplateSelectionSession, type WaltzReviewSession,
} from './sessionState';

// `@jira` is deprecated and now runs only the report imports (emails, Veracode, Waltz). Every
// other Jira task is done with the Jira tools, the /ts-jira skills and the boards; a request for
// one of them gets one fixed notice and touches nothing in Jira.

/** The intent operations `@jira` still runs. */
const IMPORT_OPERATIONS = new Set<ParsedIntent['operation']>(['createFromEmail', 'addEmailComment', 'importVeracode', 'importWaltzReport']);

/** Runs an import step and shows its failure in chat instead of letting it escape the handler. */
async function guarded(stream: vscode.ChatResponseStream, work: () => Promise<vscode.ChatResult | void>): Promise<vscode.ChatResult | void> {
  try {
    return await work();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logDiag('jira.participant', 'error', message, {});
    stream.markdown(message);
    return undefined;
  }
}

export function createJiraParticipant(
  context: vscode.ExtensionContext,
  configService: ConfigService,
  /** Runs first on every `@jira` request — `extension.ts` uses it to end the other participant's
   * sessions without this file importing it. A throw is logged and the request carries on. */
  onRequest?: () => PromiseLike<void> | void,
): vscode.ChatParticipant {
  const handler: vscode.ChatRequestHandler = async (
    request: vscode.ChatRequest,
    chatContext: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
  ): Promise<vscode.ChatResult | void> => {
    try {
      await onRequest?.();
    } catch (err) {
      logDiag('jira.participant', 'warn', 'onRequest hook failed', { error: err instanceof Error ? err.message : String(err) });
    }
    const config = await configService.getConfig();

    if (!configService.isConfigured(config)) {
      if (!config.baseUrl) {
        const settingsLink = new vscode.MarkdownString(
          '**Jira base URL not configured.**\n\n' +
          'Add `ticketSidekick.jira.baseUrl` to your VS Code settings (e.g. `https://jira.mycompany.com`), ' +
          `or [open Settings](command:workbench.action.openSettings?${encodeURIComponent(JSON.stringify('ticketSidekick.jira.baseUrl'))}) directly.`,
        );
        settingsLink.isTrusted = { enabledCommands: ['workbench.action.openSettings'] };
        stream.markdown(settingsLink);
        return;
      }
      const setupCommand = config.authType === 'cloud' ? 'ticket-sidekick.configureCloud' : 'ticket-sidekick.setDataCenterToken';
      const setupLabel = config.authType === 'cloud'
        ? 'Ticket Sidekick: Configure Jira Cloud Credentials'
        : 'Ticket Sidekick: Set Jira Personal Access Token';
      const credentialsLink = new vscode.MarkdownString(
        `**Jira credentials not configured.**\n\nRun [${setupLabel}](command:${setupCommand}) from the chat, or find it in the Command Palette.`,
      );
      credentialsLink.isTrusted = { enabledCommands: [setupCommand] };
      stream.markdown(credentialsLink);
      return;
    }

    const jiraClient = new JiraApiClient({
      baseUrl: config.baseUrl,
      authType: config.authType,
      token: config.token,
      sprintBoardId: config.sprintBoardId,
      onDiag: (level, message, details) => logDiag('jira.apiClient', level, message, details),
    });
    if (config.showConnectionInfo) {
      stream.markdown(`_${config.baseUrl} · API v2 · ${config.authType}_\n\n`);
    }
    const ticketService = new TicketService(jiraClient, (level, message, details) => logDiag('jira.ticketService', level, message, details));
    const ws = context.workspaceState;
    const active = getActiveJiraSession(chatContext)?.kinds ?? [];

    // An import waiting for an issue type when its template names none.
    if (active.includes('await-issue-type')) {
      const session = ws.get<AwaitIssueTypeSession>(AWAIT_ISSUE_TYPE_SESSION_KEY);
      if (session) {
        if (isSessionExpired(session) || session.resume.kind !== 'reportImport') {
          await ws.update(AWAIT_ISSUE_TYPE_SESSION_KEY, undefined);
          stream.markdown(SESSION_EXPIRED_MESSAGE);
          return;
        }
        // Only an explicit "(c)" cancels here, matching what the ask itself offers.
        const parsed = parseAwaitFreeTextReply(request.prompt);
        if (parsed.action === 'cancel') {
          await ws.update(AWAIT_ISSUE_TYPE_SESSION_KEY, undefined);
          stream.markdown('No issue type provided — cancelled.');
          return;
        }
        if (parsed.action === 'empty') {
          stream.markdown(trustedChatMarkdown(
            `What issue type should this use (e.g. Bug, Story, Task)?\n\nReply with a type, or ${buildChatCommandLink('Cancel', '@jira', '(c)')}.`,
          ));
          return { metadata: { jiraSession: { kinds: ['await-issue-type'] } } };
        }
        await ws.update(AWAIT_ISSUE_TYPE_SESSION_KEY, undefined);
        const { resume } = session;
        const issueType = parsed.value;
        return guarded(stream, () => {
          if (resume.descriptorKind === 'veracode') return handleVeracodeAwaitIssueType(resume, issueType, jiraClient, ticketService, stream, ws, config.baseUrl);
          if (resume.descriptorKind === 'waltz') return handleWaltzAwaitIssueType(resume, issueType, jiraClient, ticketService, stream, ws, config.baseUrl);
          return handleEmailAwaitIssueType(resume, issueType, jiraClient, ticketService, stream, ws, config.baseUrl);
        });
      }
    }

    // A Veracode or Waltz import's stepped close of stale tickets (issue type, target, resolution).
    if (active.includes('stale-resolution-selection')) {
      const ask = ws.get<StaleCloseSession>(STALE_RESOLUTION_SESSION_KEY);
      if (ask) {
        if (isSessionExpired(ask)) {
          await ws.update(STALE_RESOLUTION_SESSION_KEY, undefined);
          stream.markdown(SESSION_EXPIRED_MESSAGE);
          return;
        }
        return guarded(stream, () => (ask.descriptorKind === 'veracode'
          ? handleVeracodeStaleClose(request.prompt, ask, ticketService, stream, ws, config.baseUrl)
          : handleWaltzStaleClose(request.prompt, ask, ticketService, stream, ws, config.baseUrl)));
      }
    }

    // The email boilerplate cleanup step in front of both email flows; it handles its own expiry.
    if (active.includes('email-cleanup')) {
      const cleanupSession = ws.get<EmailCleanupSession>(EMAIL_CLEANUP_SESSION_KEY);
      if (cleanupSession) return handleEmailCleanupReply(request.prompt, cleanupSession, request.model, token, jiraClient, stream, ws);
    }

    // One email added as a comment, waiting for the confirmation.
    if (active.includes('email-content')) {
      const contentSession = ws.get<EmailContentSession>('jira.session.emailContent');
      if (contentSession) return handleEmailContentSession(request.prompt, contentSession, ticketService, stream, ws);
    }

    /** A session of one of the import screens: expired ones are cleared and said so. */
    type Handled = { result: vscode.ChatResult | void } | undefined;
    const importSession = async <T extends { schemaVersion?: number }>(kind: JiraSessionKind, key: string, run: (session: T) => Promise<vscode.ChatResult | void>): Promise<Handled> => {
      if (!active.includes(kind)) return undefined;
      const session = ws.get<T>(key);
      if (!session) return undefined;
      if (isSessionExpired(session)) {
        await ws.update(key, undefined);
        stream.markdown(SESSION_EXPIRED_MESSAGE);
        return { result: undefined };
      }
      return { result: await run(session) };
    };
    const screens: Array<() => Promise<Handled>> = [
      () => importSession<EmailTemplateSelectionSession>('email-template', 'jira.session.emailTemplateSelection',
        s => handleEmailTemplateSelection(request.prompt, s, jiraClient, ticketService, stream, ws, config.baseUrl)),
      () => importSession<EmailReviewSession>('email-review', 'jira.session.emailReview',
        s => handleEmailReviewReply(request.prompt, s, ticketService, stream, ws, config.baseUrl)),
      () => importSession<VeracodeTemplateSelectionSession>('veracode-template', 'jira.session.veracodeTemplateSelection',
        s => handleVeracodeTemplateSelection(request.prompt, s, jiraClient, ticketService, stream, ws, config.baseUrl)),
      () => importSession<VeracodeReviewSession>('veracode-review', 'jira.session.veracodeReview',
        s => handleVeracodeReviewReply(request.prompt, s, ticketService, stream, ws, config.baseUrl)),
      () => importSession<WaltzTemplateSelectionSession>('waltz-template', 'jira.session.waltzTemplateSelection',
        s => handleWaltzTemplateSelection(request.prompt, s, jiraClient, ticketService, stream, ws, config.baseUrl)),
      () => importSession<WaltzReviewSession>('waltz-review', 'jira.session.waltzReview',
        s => handleWaltzReviewReply(request.prompt, s, ticketService, stream, ws, config.baseUrl)),
    ];
    for (const screen of screens) {
      const outcome = await screen();
      if (outcome) return outcome.result;
    }

    // An empty or greeting-shaped prompt gets the help screen. The version is read here, not at
    // construction, so a context without `extension.packageJSON` cannot break activation.
    if (!request.command && isGreetingOrEmpty(request.prompt)) {
      const version = (context.extension?.packageJSON as { version?: string } | undefined)?.version ?? 'unknown';
      stream.markdown(buildJiraHelp(version));
      return;
    }

    let intent: ParsedIntent;
    try {
      intent = await parseIntent(request.prompt, request.model, token);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logDiag('jira.participant', 'error', 'Could not understand the request (intent parsing failed)', { error: message });
      stream.markdown(`Could not understand the request: ${message}\n\n${JIRA_ONLY_IMPORTS_NOTICE}`);
      return;
    }

    if (!IMPORT_OPERATIONS.has(intent.operation)) {
      logDiag('jira.participant', 'info', 'A request for a removed @jira flow got the imports-only notice', { operation: intent.operation });
      stream.markdown(JIRA_ONLY_IMPORTS_NOTICE);
      return;
    }
    switch (intent.operation) {
      case 'createFromEmail': return handleCreateFromEmail(request, stream, token, jiraClient, ticketService, configService, ws);
      case 'addEmailComment': return handleAddEmailFromChat(request, stream, token, jiraClient, ticketService, configService, ws);
      case 'importVeracode': return handleImportVeracodeReport(request, stream, token, jiraClient, ticketService, ws, intent.projectKey);
      default: return handleImportWaltzReport(request, stream, token, jiraClient, ticketService, ws, intent.projectKey);
    }
  };

  const participant = vscode.chat.createChatParticipant('ticket-sidekick.jira', handler);
  context.subscriptions.push(participant);
  return participant;
}
