import * as vscode from 'vscode';
import { JiraApiClient } from '../jira/JiraApiClient';
import { ConfigService } from '../services/ConfigService';
import { TicketService, renderFieldValue, formatKeyLink } from '../services/TicketService';
import type { JiraFieldMeta, JiraFilter, JiraSprintCandidate } from '../jira/IJiraClient';
import { TemplateService } from '../templates/TemplateService';
import type { JiraTemplate } from '../templates/TemplateService';
import { tokenStatus } from '../utils/diagUtils';
import { logDiag } from '../utils/diagLog';
import { type CreationSession, type ContentSession, type MoreCommentsSession, type TemplateSelectionSession, type IssueTypeSelectionSession, type TransitionBatchSession, type TransitionBatchTicket, type TransitionSubtask, type ResolutionSelectionSession, type CommentListSession, type FilterSelectionSession, type SearchResultSession, type BulkUpdateReviewSession, type BulkUpdateReviewRow, type FieldUpdatePreviewSession, type FieldSelectionSession, type SprintSelectionSession, type LoadSkippedSession, isConfirmation, isCancellation, parseTemplateSelection, parseIssueTypeSelection, parseSkipInput, parseResolutionSelection, buildCommentListSession, parseCommentIndex, formatCommentsInFull, parseFilterSelection, parseBulkUpdateReview, parseSkippedAttachmentSelection, rewriteAttachmentLinks, buildTeamJql, buildBulkUpdateReviewTable } from './sessionState';
import { loadWorkflowCache, findPath } from '../services/WorkflowService';
import type { WorkflowGraph } from '../services/WorkflowService';
import type { CleanupRule } from '../templates/TemplateService';
import type { Operation, ParsedIntent } from './jira/llmHelpers';
import { parseIntent, extractFixVersionFromPrompt, generateContent, isLmRefusal, synthesizeComments, generateDescriptionAndCommentsSummary, isPointerPrompt, extractLastAssistantText } from './jira/llmHelpers';
import { streamFieldUpdatePreview, continueSetField, handleSetField, handleSpellCheck } from './jira/fieldHandler';
import { getLastAssistantText, resolveTicketFromBranch, resolveProjectKey, parseLastTicketFromContext } from './jira/ticketContext';
import { validateBaseUrl } from '../services/configValidation';
import { gatherFileContent, buildContentContext, streamContentPreview, handleContentSession } from './jira/contentHandler';
import { streamIssueTypeSelection, continueAfterIssueType, streamNextSection, streamTemplateSelection, finishTicketCreation, handleCreateTicket } from './jira/createHandler';
import { serializeCommentsForLLM, handleLoadTicket } from './jira/loadHandler';
import { streamReviewScreen, executeCleanupBatch, handleRunCleanup } from './jira/cleanupHandler';
import { handleDiscoverWorkflow } from './jira/workflowHandler';
import {
  handleCreateFromEmail, handleAddEmailFromChat, handleEmailContentSession,
} from './jira/emailHandler';
import type { EmailContentSession } from './sessionState';
import {
  handleImportVeracodeReport, handleVeracodeTemplateSelection, handleVeracodeReviewReply,
} from './jira/veracodeHandler';
import type { VeracodeTemplateSelectionSession, VeracodeReviewSession } from './sessionState';
import { isSessionExpired, SESSION_EXPIRED_MESSAGE } from './sessionState';
import {
  handleImportWaltzReport, handleWaltzTemplateSelection, handleWaltzReviewReply,
} from './jira/waltzHandler';
import type { WaltzTemplateSelectionSession, WaltzReviewSession } from './sessionState';

export function createJiraParticipant(
  context: vscode.ExtensionContext,
  configService: ConfigService,
): vscode.ChatParticipant {
  const handler: vscode.ChatRequestHandler = async (
    request: vscode.ChatRequest,
    chatContext: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
  ): Promise<void> => {
    const config = await configService.getConfig();

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

    if (!config.token) {
      const setupCommand = config.authType === 'cloud'
        ? 'ticket-sidekick.configureCloud'
        : 'ticket-sidekick.setDataCenterToken';
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
    const ticketService = new TicketService(
      jiraClient,
      (level, message, details) => logDiag('jira.ticketService', level, message, details),
    );
    const ws = context.workspaceState;
    const lastResponse = getLastAssistantText(chatContext);

    if (/^check(\s+(config|connection|setup))?$/i.test(request.prompt.trim())) {
      const urlError = validateBaseUrl(config.baseUrl);
      if (urlError) {
        stream.markdown(`**Jira configuration problem**\n\n${urlError}`);
        return;
      }
      try {
        const user = await jiraClient.getCurrentUser();
        stream.markdown(
          `**Jira connection OK**\n\n` +
          `| Setting | Value |\n` +
          `|---|---|\n` +
          `| Base URL | \`${config.baseUrl ?? ''}\` |\n` +
          `| API version | v2 |\n` +
          `| Auth type | ${config.authType} |\n` +
          `| Token | ${tokenStatus(config.token)} |\n` +
          `| Logged in as | ${user.displayName} |\n`,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logDiag('jira.participant', 'error', 'Jira connection check failed', { baseUrl: config.baseUrl, authType: config.authType, error: message });
        stream.markdown(
          `**Jira connection failed**\n\n` +
          `| Setting | Value |\n` +
          `|---|---|\n` +
          `| Base URL | \`${config.baseUrl ?? ''}\` |\n` +
          `| API version | v2 |\n` +
          `| Auth type | ${config.authType} |\n` +
          `| Token | ${tokenStatus(config.token)} |\n\n` +
          `Error: ${message}`,
        );
      }
      return;
    }

    // Resolution selection — user replied with a resolution choice before the review screen
    if (lastResponse.includes('<!-- jira:selecting-resolution -->')) {
      const selSession = ws.get<ResolutionSelectionSession>('jira.session.resolutionSelection');
      if (selSession) {
        const choice = parseResolutionSelection(request.prompt, selSession.resolutionOptions);
        if (choice === 'invalid') {
          const list = selSession.resolutionOptions.map((r, i) => `${i + 1}. ${r}`).join('\n');
          stream.markdown(`Please choose a resolution:\n\n${list}\n\nReply with name or number, or **none** to skip.\n\n<!-- jira:selecting-resolution -->`);
          return;
        }
        await ws.update('jira.session.resolutionSelection', undefined);
        const batchSession: TransitionBatchSession = {
          tickets: selSession.tickets,
          resolution: choice ?? undefined,
          ruleName: selSession.ruleName,
          issueType: selSession.issueType,
        };
        const header = `**Cleanup${selSession.ruleName ? `: ${selSession.ruleName}` : ''}**`;
        await streamReviewScreen(batchSession, stream, ws, header);
        return;
      }
    }

    // Transition review — user replied ok/cancel/skip keys
    if (lastResponse.includes('<!-- jira:transition-review -->')) {
      const session = ws.get<TransitionBatchSession>('jira.session.transitionReview');
      if (session) {
        const result = parseSkipInput(request.prompt, session.tickets);
        if (result.action === 'invalid') {
          const header = `**Cleanup${session.ruleName ? `: ${session.ruleName}` : ''}**`;
          await streamReviewScreen(session, stream, ws, header);
          return;
        }
        await ws.update('jira.session.transitionReview', undefined);
        if (result.action === 'cancel') {
          stream.markdown('_Cancelled — no tickets were changed._');
          return;
        }
        const skipKeys = new Set<string>(result.action === 'skip' ? result.keys : []);
        try {
          await executeCleanupBatch(session, skipKeys, ticketService, stream);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logDiag('jira.participant', 'error', message, {});
          stream.markdown(message);
        }
        return;
      }
    }

    // Filter selection — user replied with their filter choice
    if (lastResponse.includes('<!-- jira:selecting-filter -->')) {
      const selSession = ws.get<FilterSelectionSession>('jira.session.filterSelection');
      if (selSession) {
        const choice = parseFilterSelection(request.prompt, selSession.filters);
        if (choice === 'invalid') {
          const list = selSession.filters.map((f, i) => `${i + 1}. ${f.name}`).join('\n');
          stream.markdown(`Please choose a filter:\n\n${list}\n\nReply with the number or name, or **(c)** to cancel.\n\n<!-- jira:selecting-filter -->`);
          return;
        }
        await ws.update('jira.session.filterSelection', undefined);
        if (choice === 'cancel') {
          stream.markdown('_Cancelled._');
          return;
        }
        try {
          const raw = await ticketService.searchTicketsRaw(choice.jql);
          if (raw.issues.length > 0) {
            await ws.update('jira.session.searchResult', { ticketKeys: raw.issues.map(i => i.key), jql: choice.jql } as SearchResultSession);
          }
          const result = await ticketService.searchTickets(choice.jql);
          stream.markdown(`_Using filter: **${choice.name}**_\n\n${result}`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logDiag('jira.participant', 'error', message, {});
          stream.markdown(message);
        }
        return;
      }
    }

    // Template selection — user replied with their template choice
    if (lastResponse.includes('<!-- jira:selecting-template -->')) {
      const selSession = ws.get<TemplateSelectionSession>('jira.session.templateSelection');
      if (selSession) {
        const choice = parseTemplateSelection(request.prompt, selSession.templateNames);
        if (choice === 'invalid') {
          await streamTemplateSelection(selSession.templateNames, stream, ws, selSession.originalPrompt);
          return;
        }
        await ws.update('jira.session.templateSelection', undefined);
        if (choice === 'cancel') {
          stream.markdown('_Cancelled._');
          return;
        }
        try {
          await handleCreateTicket(request, stream, token, jiraClient, ticketService, ws, choice, selSession.originalPrompt);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logDiag('jira.participant', 'error', message, {});
          stream.markdown(message);
        }
        return;
      }
    }

    // Issue type selection — user replied with their type choice
    if (lastResponse.includes('<!-- jira:selecting-type -->')) {
      const typeSession = ws.get<IssueTypeSelectionSession>('jira.session.typeSelection');
      if (typeSession) {
        const choice = parseIssueTypeSelection(request.prompt, typeSession.issueTypes);
        if (choice === 'invalid') {
          await streamIssueTypeSelection(typeSession, stream, ws);
          return;
        }
        await ws.update('jira.session.typeSelection', undefined);
        if (choice === 'cancel') {
          stream.markdown('_Cancelled._');
          return;
        }
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
        let selectedTemplate: JiraTemplate | null = null;
        if (typeSession.templateName && workspaceRoot) {
          try {
            const { templates } = new TemplateService(workspaceRoot).loadTemplates();
            selectedTemplate = templates.find((t) => t.name === typeSession.templateName) ?? null;
          } catch (err) {
            logDiag('jira.participant', 'warn', `Could not reload template — ${typeSession.templateName}`, {
              templateName: typeSession.templateName, error: err instanceof Error ? err.message : String(err),
            });
          }
        }
        try {
          await continueAfterIssueType(
            typeSession.project, typeSession.summary, choice, typeSession.description,
            selectedTemplate, request.model, stream, token, jiraClient, ticketService, ws,
            typeSession.extraFields,
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logDiag('jira.participant', 'error', message, {});
          stream.markdown(message);
        }
        return;
      }
    }

    // Creation session continuation — user answered a section prompt
    if (lastResponse.includes('<!-- jira:creating -->')) {
      const session = ws.get<CreationSession>('jira.session.creating');
      if (session) {
        try {
          const justAnswered = session.pending[0];
          if (justAnswered === '__summary__') {
            session.summary = request.prompt;
          } else {
            session.answers[justAnswered] = request.prompt;
          }
          session.pending = session.pending.slice(1);
          if (session.pending.length === 0) {
            await ws.update('jira.session.creating', undefined);
            await finishTicketCreation(session, stream, ws);
          } else {
            await streamNextSection(session, stream, ws);
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logDiag('jira.participant', 'error', message, {});
          stream.markdown(message);
        }
        return;
      }
    }

    // Content session — comment/description preview awaiting confirm/refine
    if (lastResponse.includes('<!-- jira:previewing -->')) {
      const session = ws.get<ContentSession>('jira.session.previewing');
      if (session) {
        try {
          await handleContentSession(session, request.prompt, request.model, token, stream, ticketService, ws, config.baseUrl);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logDiag('jira.participant', 'error', message, {});
          stream.markdown(message);
        }
        return;
      }
    }

    // Sprint selection — user replied with their sprint choice
    if (lastResponse.includes('<!-- jira:sprint-selection -->')) {
      const sprintSession = ws.get<SprintSelectionSession>('jira.session.sprintSelection');
      if (sprintSession) {
        const trimmed = request.prompt.trim();
        if (/^(c|cancel)$/i.test(trimmed)) {
          await ws.update('jira.session.sprintSelection', undefined);
          stream.markdown('_Cancelled._');
          return;
        }
        const idx = parseInt(trimmed, 10);
        if (isNaN(idx) || idx < 1 || idx > sprintSession.candidates.length) {
          const list = sprintSession.candidates.map((s, i) => `${i + 1}. ${s.name} (${s.state})`).join('\n');
          stream.markdown(`Please reply with a number (1–${sprintSession.candidates.length}):\n\n${list}\n\n<!-- jira:sprint-selection -->`);
          return;
        }
        await ws.update('jira.session.sprintSelection', undefined);
        const chosen = sprintSession.candidates[idx - 1];
        if (sprintSession.pending.kind === 'field-update') {
          const preview: FieldUpdatePreviewSession = {
            ...sprintSession.pending.session,
            fieldValue: chosen.id,
          };
          await streamFieldUpdatePreview(preview, stream, ws);
        }
        return;
      }
    }

    // Field selection — user replied with their field choice
    if (lastResponse.includes('<!-- jira:selecting-field -->')) {
      const fieldSelSession = ws.get<FieldSelectionSession>('jira.session.fieldSelection');
      if (fieldSelSession) {
        const trimmed = request.prompt.trim();
        if (/^(c|cancel)$/i.test(trimmed)) {
          await ws.update('jira.session.fieldSelection', undefined);
          stream.markdown('_Cancelled._');
          return;
        }
        const idx = parseInt(trimmed, 10);
        const chosen = (!isNaN(idx) && idx >= 1 && idx <= fieldSelSession.candidates.length)
          ? fieldSelSession.candidates[idx - 1]
          : fieldSelSession.candidates.find(f => f.name.toLowerCase() === trimmed.toLowerCase());
        if (!chosen) {
          const list = fieldSelSession.candidates.map((f, i) => `${i + 1}. ${f.name} (\`${f.id}\`)`).join('\n');
          stream.markdown(`Please reply with a number:\n\n${list}\n\n<!-- jira:selecting-field -->`);
          return;
        }
        await ws.update('jira.session.fieldSelection', undefined);
        const { fieldValue, arrayOp, ticketKeys } = fieldSelSession.pending;
        try {
          await continueSetField(ticketKeys, chosen, fieldValue, arrayOp, ticketService, stream, ws, request.model, token);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logDiag('jira.participant', 'error', message, {});
          stream.markdown(message);
        }
        return;
      }
    }

    // Field update preview — user replied ok / cancel
    if (lastResponse.includes('<!-- jira:field-update-preview -->')) {
      const previewSession = ws.get<FieldUpdatePreviewSession>('jira.session.fieldUpdatePreview');
      if (previewSession) {
        if (isCancellation(request.prompt)) {
          await ws.update('jira.session.fieldUpdatePreview', undefined);
          stream.markdown('_Cancelled._');
          return;
        }
        if (isConfirmation(request.prompt)) {
          await ws.update('jira.session.fieldUpdatePreview', undefined);
          const toUpdate = previewSession.ticketKeys;
          if (toUpdate.length === 1) {
            try {
              await jiraClient.updateIssue(toUpdate[0], { [previewSession.fieldId]: previewSession.fieldValue });
              stream.markdown(`Updated **${previewSession.fieldName}** on ${formatKeyLink(toUpdate[0], config.baseUrl)}.`);
              stream.markdown(`\n\n<!-- @jira-ticket:${toUpdate[0]} -->`);
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              logDiag('jira.participant', 'error', message, {});
              stream.markdown(message);
            }
          } else {
            let passed = 0, failed = 0;
            await ticketService.bulkUpdateField(toUpdate, previewSession.fieldId, previewSession.fieldValue, (key, ok, err) => {
              const keyRef = formatKeyLink(key, config.baseUrl);
              if (ok) { stream.markdown(`✓ ${keyRef}\n\n`); passed++; }
              else { stream.markdown(`✗ ${keyRef}: ${err}\n\n`); failed++; }
            });
            stream.markdown(`\n_Done — ${passed} updated${failed > 0 ? `, ${failed} failed` : ''}_`);
          }
          return;
        }
        // Not ok or cancel — re-present
        stream.markdown(`Please reply **post it** to apply, or **(c)** to cancel.\n\n<!-- jira:field-update-preview -->`);
        await ws.update('jira.session.fieldUpdatePreview', previewSession);
        return;
      }
    }

    // More-comments session — user confirmed "load all"
    if (lastResponse.includes('<!-- jira:more-comments -->') && isConfirmation(request.prompt)) {
      const session = ws.get<MoreCommentsSession>('jira.session.moreComments');
      if (session) {
        try {
          await ws.update('jira.session.moreComments', undefined);
          const { comments } = await ticketService.getIssueComments(session.ticketKey, 100);
          if (session.displayMode === 'full') {
            await ws.update('jira.session.commentList', buildCommentListSession(session.ticketKey, comments));
            stream.markdown(formatCommentsInFull(comments));
            stream.markdown(`\n\n<!-- @jira-ticket:${session.ticketKey} -->\n\n<!-- jira:comment-list -->`);
          } else {
            const synthesis = await synthesizeComments(
              serializeCommentsForLLM(comments),
              session.commentQuery,
              request.model,
              token,
            );
            if (!session.commentQuery) {
              await ws.update('jira.session.commentList', buildCommentListSession(session.ticketKey, comments));
            }
            stream.markdown(synthesis);
            const listTag = session.commentQuery ? '' : '\n\n<!-- jira:comment-list -->';
            stream.markdown(`\n\n<!-- @jira-ticket:${session.ticketKey} -->${listTag}`);
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logDiag('jira.participant', 'error', message, {});
          stream.markdown(message);
        }
        return;
      }
    }

    // Load skipped — user replied with a number (or "download N") to download skipped attachments
    if (lastResponse.includes('<!-- jira:load-skipped -->')) {
      const loadSkippedSession = ws.get<LoadSkippedSession>('jira.session.loadSkipped');
      if (loadSkippedSession) {
        const selection = parseSkippedAttachmentSelection(request.prompt, loadSkippedSession.skipped.length);
        const skippedList = (items: LoadSkippedSession['skipped']) => items.map((s, i) => {
          const sz = s.size >= 1_048_576 ? `${(s.size / 1_048_576).toFixed(1)} MB` : `${Math.round(s.size / 1024)} KB`;
          return `${i + 1}. \`${s.filename}\` — ${sz} (${s.mimeType}) — ${s.reason}`;
        }).join('\n');
        if (selection === 'not-a-selection') {
          await ws.update('jira.session.loadSkipped', undefined);
          // fall through to intent parsing
        } else if (selection === 'out-of-range') {
          stream.markdown(`Please reply with a number:\n\n${skippedList(loadSkippedSession.skipped)}\n\nReply with a number to download it anyway.\n\n<!-- jira:load-skipped -->`);
          return;
        } else {
          const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
          if (!workspaceFolder) {
            await ws.update('jira.session.loadSkipped', undefined);
            stream.markdown('No workspace folder is open.');
            return;
          }
          const attachmentsDir = vscode.Uri.joinPath(workspaceFolder.uri, '.jira-context', loadSkippedSession.ticketKey, 'attachments');
          const lines: string[] = [];
          const downloadedSet = new Set(selection.map(i => i - 1));
          for (const i of selection) {
            const chosen = loadSkippedSession.skipped[i - 1];
            try {
              stream.markdown(`_Downloading \`${chosen.filename}\`…_\n\n`);
              const bytes = await ticketService.downloadAttachment(chosen.content);
              await vscode.workspace.fs.createDirectory(attachmentsDir);
              await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(attachmentsDir, chosen.filename), bytes);
              lines.push(`✓ \`${chosen.filename}\` downloaded.`);
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              logDiag('jira.participant', 'warn', `Attachment download failed — ${chosen.filename}`, { fileName: chosen.filename, error: message });
              downloadedSet.delete(i - 1);
              lines.push(`✗ Failed to download \`${chosen.filename}\`: ${message}`);
            }
          }
          const remaining = loadSkippedSession.skipped.filter((_, i) => !downloadedSet.has(i));
          if (remaining.length > 0) {
            await ws.update('jira.session.loadSkipped', { ticketKey: loadSkippedSession.ticketKey, skipped: remaining } satisfies LoadSkippedSession);
            stream.markdown(`${lines.join('\n')}\n\n**Remaining skipped attachments:**\n\n${skippedList(remaining)}\n\nReply with a number to download another.\n\n<!-- @jira-ticket:${loadSkippedSession.ticketKey} -->\n\n<!-- jira:load-skipped -->`);
          } else {
            await ws.update('jira.session.loadSkipped', undefined);
            stream.markdown(`${lines.join('\n')}\n\nAll attachments saved.\n\n<!-- @jira-ticket:${loadSkippedSession.ticketKey} -->`);
          }
          return;
        }
      }
    }

    // Bulk update review — user replied ok / skip keys / cancel
    if (lastResponse.includes('<!-- jira:bulk-update-review -->')) {
      const bulkSession = ws.get<BulkUpdateReviewSession>('jira.session.bulkUpdateReview');
      if (bulkSession) {
        const decision = parseBulkUpdateReview(request.prompt);
        if (decision.action === 'invalid') {
          stream.markdown(`Didn't understand that. Reply **post it** to apply, **(c)** to cancel, or \`skip KEY1 KEY2\` to skip specific tickets.\n\n<!-- jira:bulk-update-review -->`);
          return;
        }
        await ws.update('jira.session.bulkUpdateReview', undefined);
        if (decision.action === 'cancel') {
          stream.markdown('_Cancelled — no tickets were changed._');
          return;
        }
        const skipSet = new Set(decision.skip);
        const toUpdate = bulkSession.ticketKeys.filter(k => !skipSet.has(k));
        stream.markdown(`Updating **${bulkSession.fieldName}** on ${toUpdate.length} ticket(s)…\n\n`);
        let passed = 0;
        let failed = 0;
        await ticketService.bulkUpdateField(toUpdate, bulkSession.fieldId, bulkSession.fieldValue, (key, ok, err) => {
          if (ok) { stream.markdown(`✓ ${key}\n\n`); passed++; }
          else { stream.markdown(`✗ ${key}: ${err}\n\n`); failed++; }
        });
        stream.markdown(`\n_Done — ${passed} updated${failed > 0 ? `, ${failed} failed` : ''}_`);
        return;
      }
    }

    // Email content session — user is confirming/refining ticket content from email
    if (lastResponse.includes('<!-- jira:email-content -->')) {
      const contentSession = ws.get<EmailContentSession>('jira.session.emailContent');
      if (contentSession) {
        await handleEmailContentSession(request.prompt, contentSession, ticketService, stream, ws, jiraClient);
        return;
      }
    }

    // Veracode template/issue-type selection
    if (lastResponse.includes('<!-- jira:veracode-template -->')) {
      const templateSession = ws.get<VeracodeTemplateSelectionSession>('jira.session.veracodeTemplateSelection');
      if (templateSession) {
        if (isSessionExpired(templateSession)) {
          await ws.update('jira.session.veracodeTemplateSelection', undefined);
          stream.markdown(SESSION_EXPIRED_MESSAGE);
          return;
        }
        await handleVeracodeTemplateSelection(request.prompt, templateSession, jiraClient, ticketService, stream, ws, config.baseUrl);
        return;
      }
    }

    // Veracode flaw review / selection screen
    if (lastResponse.includes('<!-- jira:veracode-review -->')) {
      const reviewSession = ws.get<VeracodeReviewSession>('jira.session.veracodeReview');
      if (reviewSession) {
        if (isSessionExpired(reviewSession)) {
          await ws.update('jira.session.veracodeReview', undefined);
          stream.markdown(SESSION_EXPIRED_MESSAGE);
          return;
        }
        await handleVeracodeReviewReply(request.prompt, reviewSession, ticketService, stream, ws, config.baseUrl);
        return;
      }
    }

    // Waltz OSS report template/issue-type selection
    if (lastResponse.includes('<!-- jira:waltz-template -->')) {
      const templateSession = ws.get<WaltzTemplateSelectionSession>('jira.session.waltzTemplateSelection');
      if (templateSession) {
        if (isSessionExpired(templateSession)) {
          await ws.update('jira.session.waltzTemplateSelection', undefined);
          stream.markdown(SESSION_EXPIRED_MESSAGE);
          return;
        }
        await handleWaltzTemplateSelection(request.prompt, templateSession, jiraClient, ticketService, stream, ws, config.baseUrl);
        return;
      }
    }

    // Waltz OSS report review / selection screen
    if (lastResponse.includes('<!-- jira:waltz-review -->')) {
      const reviewSession = ws.get<WaltzReviewSession>('jira.session.waltzReview');
      if (reviewSession) {
        if (isSessionExpired(reviewSession)) {
          await ws.update('jira.session.waltzReview', undefined);
          stream.markdown(SESSION_EXPIRED_MESSAGE);
          return;
        }
        await handleWaltzReviewReply(request.prompt, reviewSession, ticketService, stream, ws, config.baseUrl);
        return;
      }
    }

    // Comment list — user replied with a comment number to view in full
    if (lastResponse.includes('<!-- jira:comment-list -->')) {
      const commentSession = ws.get<CommentListSession>('jira.session.commentList');
      if (commentSession) {
        const index = parseCommentIndex(request.prompt, commentSession.comments.length);
        if (index !== 'invalid') {
          const entry = commentSession.comments[index - 1];
          stream.markdown(`**Comment ${index}** — ${entry.author} (${entry.date})\n\n${entry.bodyMarkdown}`);
          stream.markdown(`\n\n<!-- @jira-ticket:${commentSession.ticketKey} -->\n\n<!-- jira:comment-list -->`);
          return;
        }
        // Not a comment index — fall through to intent parse
      }
    }

    let intent: ParsedIntent;
    try {
      intent = await parseIntent(request.prompt, request.model, token);
      if (intent.operation === 'runCleanup') {
        const fv = extractFixVersionFromPrompt(request.prompt);
        if (fv) intent = { ...intent, fixVersion: fv };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logDiag('jira.participant', 'error', 'Could not understand the request (intent parsing failed)', { error: message });
      stream.markdown(`Could not understand the request: ${message}`);
      return;
    }

    // createTicket has its own multi-turn flow
    if (intent.operation === 'createTicket') {
      try {
        await handleCreateTicket(request, stream, token, jiraClient, ticketService, ws);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logDiag('jira.participant', 'error', message, {});
        stream.markdown(message);
      }
      return;
    }

    if (intent.operation === 'discoverWorkflow') {
      try {
        await handleDiscoverWorkflow(intent, stream, jiraClient);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logDiag('jira.participant', 'error', message, {});
        stream.markdown(message);
      }
      return;
    }

    if (intent.operation === 'runCleanup') {
      try {
        await handleRunCleanup(intent, stream, jiraClient, ticketService, ws, config.baseUrl);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logDiag('jira.participant', 'error', message, {});
        stream.markdown(message);
      }
      return;
    }

    if (intent.operation === 'createFromEmail') {
      await handleCreateFromEmail(request, stream, token, jiraClient, ticketService, configService, ws);
      return;
    }

    if (intent.operation === 'addEmailComment') {
      await handleAddEmailFromChat(request, stream, token, jiraClient, ticketService, configService, ws);
      return;
    }

    if (intent.operation === 'importVeracode') {
      await handleImportVeracodeReport(request, stream, token, jiraClient, ticketService, ws, intent.projectKey);
      return;
    }

    if (intent.operation === 'importWaltzReport') {
      await handleImportWaltzReport(request, stream, token, jiraClient, ticketService, ws, intent.projectKey);
      return;
    }

    let ticketKey = intent.ticketKey;
    if (!ticketKey && intent.operation !== 'searchJql' && intent.operation !== 'bulkTransition' && intent.operation !== 'bulkUpdateField') {
      ticketKey = resolveTicketFromBranch();
      if (ticketKey) {
        stream.markdown(`_Using ticket **${ticketKey}** from current branch._\n\n`);
      } else {
        ticketKey = parseLastTicketFromContext(chatContext);
        if (ticketKey) {
          stream.markdown(`_Using last referenced ticket **${ticketKey}**._\n\n`);
        } else {
          stream.markdown('Which ticket are you referring to? (e.g. `@jira show me PROJ-123`)');
          return;
        }
      }
    }

    try {
      let result: string;
      switch (intent.operation) {
        case 'getTicket': {
          const fieldMeta = await ticketService.getFieldMeta();
          const alwaysShowIds = new Set<string>(config.additionalDisplayFields);
          const hiddenIds = new Set<string>(config.hiddenDisplayFields);
          const base = await ticketService.getTicket(ticketKey!, fieldMeta, alwaysShowIds, hiddenIds, config.baseUrl);
          const MAX_SHOW = 20;
          const { comments, total } = await ticketService.getIssueComments(ticketKey!, MAX_SHOW);
          if (comments.length > 0) {
            const synthesis = await synthesizeComments(
              serializeCommentsForLLM(comments),
              null,
              request.model,
              token,
            );
            await ws.update('jira.session.commentList', buildCommentListSession(ticketKey!, comments));
            stream.markdown(base + '\n\n**Comments (summarized):**\n\n' + synthesis);
            if (total > MAX_SHOW) {
              const moreSession: MoreCommentsSession = { ticketKey: ticketKey!, commentQuery: null };
              await ws.update('jira.session.moreComments', moreSession);
              stream.markdown(`\n\n_${total - MAX_SHOW} older comment(s) not shown. Reply **"load all"** to include them._\n\n<!-- @jira-ticket:${ticketKey} -->\n\n<!-- jira:more-comments -->\n\n<!-- jira:comment-list -->`);
            } else {
              stream.markdown(`\n\n<!-- @jira-ticket:${ticketKey} -->\n\n<!-- jira:comment-list -->`);
            }
            return;
          }
          result = base;
          break;
        }
        case 'summarizeTicket': {
          const summaryFieldMeta = await ticketService.getFieldMeta();
          const summaryAlwaysShow = new Set<string>(config.additionalDisplayFields);
          const summaryHidden = new Set<string>(config.hiddenDisplayFields);
          const fullTicket = await ticketService.getTicket(ticketKey!, summaryFieldMeta, summaryAlwaysShow, summaryHidden, config.baseUrl);
          // Title + table before the first ## section heading
          const sectionStart = fullTicket.indexOf('\n\n## ');
          const fieldsHeader = sectionStart >= 0 ? fullTicket.slice(0, sectionStart) : fullTicket;
          const descriptionText = sectionStart >= 0 ? fullTicket.slice(sectionStart + 2) : '';
          const { comments: summaryComments } = await ticketService.getIssueComments(ticketKey!, 20);
          const commentBlocks = summaryComments.length > 0 ? serializeCommentsForLLM(summaryComments) : null;
          const synthesis = await generateDescriptionAndCommentsSummary(descriptionText, commentBlocks, request.model, token);
          stream.markdown(fieldsHeader + '\n\n**Overview (summarized):**\n\n' + synthesis);
          stream.markdown(`\n\n<!-- @jira-ticket:${ticketKey} -->`);
          return;
        }
        case 'showComments': {
          const MAX_SHOW_FULL = 20;
          const { comments: fullComments, total: fullTotal } = await ticketService.getIssueComments(ticketKey!, MAX_SHOW_FULL);
          if (fullComments.length === 0) {
            result = `No comments on ${ticketKey}.`;
            break;
          }
          await ws.update('jira.session.commentList', buildCommentListSession(ticketKey!, fullComments));
          const showTicketRef = formatKeyLink(ticketKey!, config.baseUrl);
          stream.markdown(`## ${showTicketRef} — Comments (${fullTotal})\n\n` + formatCommentsInFull(fullComments));
          if (fullTotal > MAX_SHOW_FULL) {
            const moreSession: MoreCommentsSession = { ticketKey: ticketKey!, commentQuery: null, displayMode: 'full' };
            await ws.update('jira.session.moreComments', moreSession);
            stream.markdown(`\n\n_${fullTotal - MAX_SHOW_FULL} older comment(s) not shown. Reply **"load all"** to include them._\n\n<!-- @jira-ticket:${ticketKey} -->\n\n<!-- jira:more-comments -->\n\n<!-- jira:comment-list -->`);
          } else {
            stream.markdown(`\n\n<!-- @jira-ticket:${ticketKey} -->\n\n<!-- jira:comment-list -->`);
          }
          return;
        }
        case 'getComments': {
          const MAX_INITIAL = 20;
          const { comments, total } = await ticketService.getIssueComments(ticketKey!, MAX_INITIAL);
          if (comments.length === 0) {
            result = `No comments on ${ticketKey}.`;
            break;
          }
          const synthesis = await synthesizeComments(
            serializeCommentsForLLM(comments),
            intent.commentQuery,
            request.model,
            token,
          );
          const hasQuery = Boolean(intent.commentQuery);
          if (!hasQuery) {
            await ws.update('jira.session.commentList', buildCommentListSession(ticketKey!, comments));
          }
          const getCommentsRef = formatKeyLink(ticketKey!, config.baseUrl);
          stream.markdown(`**${getCommentsRef} — Comments**\n\n` + synthesis);
          const listTag = hasQuery ? '' : '\n\n<!-- jira:comment-list -->';
          if (total > MAX_INITIAL) {
            const moreSession: MoreCommentsSession = { ticketKey: ticketKey!, commentQuery: intent.commentQuery };
            await ws.update('jira.session.moreComments', moreSession);
            stream.markdown(`\n\n_${total - MAX_INITIAL} older comment(s) not shown. Reply **"load all"** to include them._\n\n<!-- @jira-ticket:${ticketKey} -->\n\n<!-- jira:more-comments -->${listTag}`);
          } else {
            stream.markdown(`\n\n<!-- @jira-ticket:${ticketKey} -->${listTag}`);
          }
          return;
        }
        case 'addComment': {
          const isLiteral = intent.contentSource === 'literal' || intent.contentSource === undefined;
          if (!intent.comment && isLiteral) {
            stream.markdown('What comment would you like to add?');
            return;
          }
          if (isLiteral) {
            result = await ticketService.addComment(ticketKey!, intent.comment!, config.baseUrl);
          } else {
            const ticketText = await ticketService.getTicket(ticketKey!);
            const { comments } = await ticketService.getIssueComments(ticketKey!, 50);
            const commentBlocks = comments.length > 0 ? serializeCommentsForLLM(comments) : '';

            // Verbatim shortcut: when the user points at the previous response ("post it",
            // "use that"), copy the last assistant turn directly instead of re-generating.
            if (intent.contentSource === 'history-recent' && isPointerPrompt(request.prompt)) {
              const lastText = extractLastAssistantText(chatContext);
              if (lastText.length > 200) {
                await streamContentPreview(
                  { ticketKey: ticketKey!, operation: 'addComment', currentContent: lastText, historyContext: undefined, contentSource: 'history-recent' },
                  stream, ws,
                );
                return;
              }
            }

            const nonLiteralSource = intent.contentSource as 'generate' | 'history-recent' | 'history-full';
            const context = await buildContentContext(request, chatContext, ticketText, commentBlocks, nonLiteralSource);
            const content = await generateContent(request.prompt, request.model, token, context, nonLiteralSource);
            if (isLmRefusal(content)) {
              stream.markdown(`_Could not generate comment content — the AI model declined the request. Try rephrasing your instruction or use \`@jira add comment to ${ticketKey}\` with explicit text._`);
              return;
            }
            await streamContentPreview(
              { ticketKey: ticketKey!, operation: 'addComment', currentContent: content, historyContext: context, contentSource: nonLiteralSource },
              stream, ws,
            );
            return;
          }
          break;
        }
        case 'updateField': {
          const fieldNameRaw = intent.fieldName ?? intent.fieldUpdates?.[0]?.fieldName;
          const fieldValueRaw = intent.fieldValue ?? intent.fieldUpdates?.[0]?.fieldValue ?? '';
          if (!fieldNameRaw) {
            stream.markdown('Please specify a field name and value to update.');
            return;
          }
          // Description with non-literal content → ContentSession
          const isNonLiteral = intent.contentSource !== 'literal' && intent.contentSource !== undefined;
          if (fieldNameRaw.toLowerCase() === 'description' && isNonLiteral) {
            const descFieldMeta = await ticketService.getFieldMeta();
            const descAlwaysShow = new Set<string>(config.additionalDisplayFields);
            const descHidden = new Set<string>(config.hiddenDisplayFields);
            const ticketText = await ticketService.getTicket(ticketKey!, descFieldMeta, descAlwaysShow, descHidden);
            const { comments } = await ticketService.getIssueComments(ticketKey!, 20);
            const commentBlocks = comments.length > 0 ? serializeCommentsForLLM(comments) : '';
            const nonLiteralSource = intent.contentSource as 'generate' | 'history-recent' | 'history-full';
            const contentCtx = await buildContentContext(request, chatContext, ticketText, commentBlocks, nonLiteralSource);
            const content = await generateContent(fieldValueRaw, request.model, token, contentCtx, nonLiteralSource);
            if (isLmRefusal(content)) {
              stream.markdown(`_Could not generate description content — the AI model declined the request. Try rephrasing your instruction._`);
              return;
            }
            await streamContentPreview(
              { ticketKey: ticketKey!, operation: 'updateDescription', currentContent: content, historyContext: contentCtx, contentSource: nonLiteralSource },
              stream, ws,
            );
            return;
          }
          // All other fields → fuzzy match + preview flow
          const setFieldMeta = await ticketService.getFieldMeta();
          const setTicketKeys = intent.scope === 'bulk'
            ? (ws.get<SearchResultSession>('jira.session.searchResult')?.ticketKeys ?? [ticketKey!])
            : [ticketKey!];
          await handleSetField(
            setTicketKeys, fieldNameRaw, fieldValueRaw, intent.arrayOp ?? 'set',
            setFieldMeta, ticketService, stream, ws, request.model, token,
          );
          return;
        }
        case 'showFields': {
          const showFieldMeta = await ticketService.getFieldMeta();
          result = await ticketService.showFields(ticketKey!, showFieldMeta);
          break;
        }
        case 'searchJql': {
          let resolvedJql: string;
          let jqlLabel = '';
          if (intent.filterId) {
            const filter = await ticketService.getFilterById(intent.filterId);
            resolvedJql = filter.jql;
            jqlLabel = `_Using filter: **${filter.name}**_\n\n`;
          } else if (intent.filterName) {
            const filters = await ticketService.searchFiltersByName(intent.filterName);
            if (filters.length === 0) {
              result = `No saved filters found matching "${intent.filterName}".`;
              break;
            } else if (filters.length === 1) {
              resolvedJql = filters[0].jql;
              jqlLabel = `_Using filter: **${filters[0].name}**_\n\n`;
            } else {
              const session: FilterSelectionSession = { filters, originalPrompt: request.prompt };
              await ws.update('jira.session.filterSelection', session);
              const list = filters.map((f, i) => `${i + 1}. ${f.name}`).join('\n');
              stream.markdown(`Multiple filters match "${intent.filterName}":\n\n${list}\n\nWhich one? Reply with the number or name, or **(c)** to cancel.\n\n<!-- jira:selecting-filter -->`);
              return;
            }
          } else if (intent.useMyTeamJql) {
            const teamJql = config.myTeamJql;
            if (!teamJql) {
              result =
                'No team JQL configured. Set `ticketSidekick.jira.myTeamJql` in your VS Code settings (e.g. `project = BACKEND AND assignee in membersOf("backend-team")`).';
              break;
            }
            resolvedJql = buildTeamJql(teamJql, intent.jql);
            jqlLabel = `_Using team JQL_\n\n`;
          } else {
            resolvedJql = intent.jql ?? request.prompt;
          }
          const raw = await ticketService.searchTicketsRaw(resolvedJql);
          if (raw.issues.length > 0) {
            const searchSession: SearchResultSession = { ticketKeys: raw.issues.map(i => i.key), jql: resolvedJql };
            await ws.update('jira.session.searchResult', searchSession);
          }
          const searchFieldMeta = config.searchFields.length > 0 ? await ticketService.getFieldMeta() : [];
          result = jqlLabel + await ticketService.searchTickets(resolvedJql, config.baseUrl, config.searchFields, searchFieldMeta);
          break;
        }
        case 'transition': {
          if (!intent.targetStatus) {
            result = 'Please specify a target status (e.g. "move to Done").';
            break;
          }
          const targetStatus = intent.targetStatus;
          const transIssue = await jiraClient.getIssue(ticketKey!);
          const currentStatus = transIssue.fields.status.name;
          if (currentStatus.toLowerCase() === targetStatus.toLowerCase()) {
            result = `**${ticketKey}** is already in **${currentStatus}**.`;
            break;
          }
          const transitionList = await jiraClient.getTransitions(ticketKey!);
          const direct = transitionList.find(t => t.to.name.toLowerCase() === targetStatus.toLowerCase());
          const resolution = intent.resolution ?? undefined;
          if (direct) {
            await ticketService.transitionAlongPath(ticketKey!, [{ id: direct.id, name: direct.name, to: direct.to.name }], resolution);
            result = `**${ticketKey}** moved to **${direct.to.name}**.`;
            break;
          }
          // Fall back to workflow cache for multi-hop paths
          const transWorkspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
          const transProjectKey = ticketKey!.split('-')[0];
          const transIssueType = (transIssue.fields.issuetype as { name?: string } | undefined)?.name ?? '';
          const transGraph = loadWorkflowCache(transWorkspaceRoot)[transProjectKey]?.[transIssueType]?.graph;
          if (transGraph) {
            const path = findPath(transGraph, currentStatus, targetStatus);
            if (path && path.length > 0) {
              await ticketService.transitionAlongPath(ticketKey!, path, resolution);
              result = `**${ticketKey}** moved to **${targetStatus}** (${path.length} hop${path.length > 1 ? 's' : ''}).`;
              break;
            }
          }
          const available = transitionList.map(t => `**${t.to.name}**`).join(', ');
          const cacheHint = transGraph
            ? ''
            : ` Run \`@jira discover workflow ${transProjectKey} ${transIssueType || '<issuetype>'}\` to enable multi-hop transitions.`;
          result = `No transition to **${targetStatus}** available from **${currentStatus}**.${available ? ` Available: ${available}.` : ''}${cacheHint}`;
          break;
        }
        case 'bulkTransition': {
          const searchSession = ws.get<SearchResultSession>('jira.session.searchResult');
          if (!searchSession || searchSession.ticketKeys.length === 0) {
            result = 'No previous search results to act on. Run a search first.';
            break;
          }
          if (!intent.targetStatus) {
            result = 'Please specify a target status (e.g. "transition them to Done").';
            break;
          }
          const targetStatus = intent.targetStatus;
          stream.markdown(`_Building transition paths…_\n\n`);
          const tickets: TransitionBatchTicket[] = [];
          for (const key of searchSession.ticketKeys) {
            const issue = await jiraClient.getIssue(key);
            const transitions = await jiraClient.getTransitions(key);
            // Build a single-level graph from the ticket's current available transitions
            const graph: WorkflowGraph = {
              [issue.fields.status.name]: transitions.map(t => ({ id: t.id, name: t.name, to: t.to.name })),
            };
            const currentStatus = issue.fields.status.name;
            const path = findPath(graph, currentStatus, targetStatus);
            if (path === null) {
              stream.markdown(`_Warning: no direct transition from **${currentStatus}** to **${targetStatus}** for ${key} — skipping. Use a workflow cache for multi-hop paths._\n\n`);
              continue;
            }
            const subtasks: TransitionSubtask[] = [];
            for (const s of (issue.fields.subtasks ?? [])) {
              const subTransitions = await jiraClient.getTransitions(s.key);
              const subGraph: WorkflowGraph = {
                [s.fields.status.name]: subTransitions.map(t => ({ id: t.id, name: t.name, to: t.to.name })),
              };
              const subPath = findPath(subGraph, s.fields.status.name, targetStatus);
              if (subPath) subtasks.push({ key: s.key, summary: s.fields.summary, currentStatus: s.fields.status.name, transitionPath: subPath });
            }
            tickets.push({ key, summary: issue.fields.summary, currentStatus, transitionPath: path, subtasks });
          }
          if (tickets.length === 0) {
            result = `No tickets could be transitioned to **${targetStatus}** — all were either already there or have no direct path.`;
            break;
          }
          const CLOSED_STATES = new Set(['done', 'closed', 'resolved', 'cancelled', 'canceled']);
          if (CLOSED_STATES.has(targetStatus.toLowerCase())) {
            const resolutions = await jiraClient.getResolutions();
            if (resolutions.length > 0) {
              const resSession: ResolutionSelectionSession = {
                resolutionOptions: resolutions.map(r => r.name),
                tickets,
                ruleName: undefined,
                issueType: intent.issueType ?? '',
                targetState: targetStatus,
              };
              await ws.update('jira.session.resolutionSelection', resSession);
              const list = resolutions.map((r, i) => `${i + 1}. ${r.name}`).join('\n');
              stream.markdown(`Which resolution should be set when transitioning to **${targetStatus}**?\n\n${list}\n\nReply with the name or number, or **none** to skip setting a resolution.\n\n<!-- jira:selecting-resolution -->`);
              return;
            }
          }
          const batchSession: TransitionBatchSession = { tickets, resolution: undefined, ruleName: undefined, issueType: intent.issueType ?? '' };
          await streamReviewScreen(batchSession, stream, ws, `**Bulk transition → ${targetStatus}**`);
          return;
        }
        case 'bulkUpdateField': {
          const searchSession = ws.get<SearchResultSession>('jira.session.searchResult');
          if (!searchSession || searchSession.ticketKeys.length === 0) {
            result = 'No previous search results to act on. Run a search first.';
            break;
          }
          if (!intent.bulkFieldName || intent.bulkFieldValue === null) {
            result = 'Please specify both a field name and a value (e.g. "set Team Names to ASL Cary").';
            break;
          }
          const fieldId = await ticketService.resolveFieldId(intent.bulkFieldName);
          const allFieldMeta = await ticketService.getFieldMeta();
          const targetFieldMeta = allFieldMeta.find(f => f.id === fieldId);
          const isSprintField = Boolean(targetFieldMeta?.schema.custom?.includes('gh-sprint'));

          let fieldValue: unknown;
          if (isSprintField) {
            const projectKey = searchSession.ticketKeys[0].split('-')[0];
            let candidates;
            try {
              candidates = await ticketService.findSprints(projectKey, intent.bulkFieldValue!);
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              logDiag('jira.participant', 'error', message, {});
              result = `Could not search sprints: ${message}`;
              break;
            }
            if (candidates.length === 0) {
              result = `No active or future sprint matching "${intent.bulkFieldValue}" in project ${projectKey}.`;
              break;
            }
            const chosen = candidates.find(s => s.state === 'active') ?? candidates[0];
            fieldValue = chosen.id;
          } else {
            fieldValue = await ticketService.buildFieldValue(fieldId, searchSession.ticketKeys[0], intent.bulkFieldValue!);
          }

          const issues = await Promise.all(searchSession.ticketKeys.map(k => jiraClient.getIssue(k)));
          const reviewRows: BulkUpdateReviewRow[] = issues.map(issue => {
            const current = issue.fields[fieldId];
            const display = current !== null && current !== undefined && targetFieldMeta
              ? renderFieldValue(current, targetFieldMeta)
              : current !== null && current !== undefined
                ? String(current)
                : '—';
            return { key: issue.key, summary: issue.fields.summary, currentValueDisplay: display };
          });
          const bulkSession: BulkUpdateReviewSession = {
            ticketKeys: searchSession.ticketKeys,
            fieldId,
            fieldName: intent.bulkFieldName,
            fieldValue,
            arrayOp: 'set',
          };
          await ws.update('jira.session.bulkUpdateReview', bulkSession);
          stream.markdown(
            `**Bulk update: ${intent.bulkFieldName} → ${intent.bulkFieldValue}**\n` +
            `(${searchSession.ticketKeys.length} tickets)\n\n` +
            (config.baseUrl ? `[View in Jira](${config.baseUrl}/issues/?jql=${encodeURIComponent(searchSession.jql)})\n\n` : '') +
            buildBulkUpdateReviewTable(reviewRows) +
            `\n\nReply **post it** to apply, **(c)** to cancel, or list keys to skip (e.g. \`skip PROJ-2\`).\n\n<!-- jira:bulk-update-review -->`
          );
          return;
        }
        case 'loadTicket': {
          const loadFieldMeta = await ticketService.getFieldMeta();
          const loadAlwaysShow = new Set<string>(config.additionalDisplayFields);
          const loadHidden = new Set<string>(config.hiddenDisplayFields);
          await handleLoadTicket(ticketKey!, ticketService, stream, ws, loadFieldMeta, loadAlwaysShow, loadHidden);
          return;
        }
        case 'validateFields':
          result = await ticketService.validateRequiredFields(ticketKey!, config.requiredFields);
          break;
        case 'spellCheck': {
          if (!ticketKey) {
            stream.markdown('No ticket key found. Please specify a ticket, e.g. `@jira spell check PROJ-123`.');
            return;
          }
          await handleSpellCheck(ticketKey, ticketService, request.model, stream, token, ws);
          return;
        }
        default:
          result = 'Unrecognised operation.';
      }
      stream.markdown(result);
      if (ticketKey) stream.markdown(`\n\n<!-- @jira-ticket:${ticketKey} -->`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logDiag('jira.participant', 'error', message, { operation: intent.operation });
      stream.markdown(message);
    }
  };

  const participant = vscode.chat.createChatParticipant('ticket-sidekick.jira', handler);
  context.subscriptions.push(participant);
  return participant;
}
