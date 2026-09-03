import * as vscode from 'vscode';
import { JiraApiClient } from '../jira/JiraApiClient';
import { ConfigService, type JiraConfig } from '../services/ConfigService';
import { TicketService, renderFieldValue } from '../services/TicketService';
import { TemplateService } from '../templates/TemplateService';
import { FieldResolver } from '../templates/FieldResolver';
import { discoverAndCacheWorkflow, resolveAndApplyTransition } from '../services/WorkflowService';
import { attachmentsDirFor, ensureJiraContextGitignored, loadTicketToWorkspace } from '../participant/jira/loadHandler';
import { logDiag } from '../utils/diagLog';
import { isSafePathSegment } from './pathSafety';
import { RecentCallGuard, fingerprint } from './recentCallGuard';
import { ATTACHMENT_SIZE_LIMIT, findAttachmentByFilename, formatFileSize } from '../utils/attachmentEligibility';
import {
  buildJiraNotConfiguredMessage,
  formatCommentsInFull,
  buildUpdateFieldConfirmation,
  buildAddCommentConfirmation,
  buildCreateTicketConfirmation,
  buildTransitionConfirmation,
  buildLoadTicketConfirmation,
  buildLoadTicketResultMessage,
  buildDownloadAttachmentConfirmation,
  buildAttachmentNotFoundMessage,
  buildDownloadAttachmentResultMessage,
  formatIssueTypeOptionsMessage,
  formatTemplateListMessage,
  formatWorkflowDiscoveryMessage,
} from '../participant/sessionState';

// ---------------------------------------------------------------------------------------------
// Language Model tools (Agent Mode) for @jira, registered via `vscode.lm.registerTool` in
// `registerJiraTools()` below and declared in package.json's `contributes.languageModelTools`.
//
// Every tool here is thin glue: it resolves live data through the same three-layer stack the
// `@jira` chat participant uses (TicketService → IJiraClient → JiraApiClient) and hands the
// result to the pure formatters in `sessionState.ts` (R3 — no separate, divergent
// implementation of the same operation). All confirmation-text/result-wording logic lives there
// so it stays Vitest-loadable; this file (importing `vscode`) is covered only by `npm run
// compile` and a manual Extension Development Host check (see CLAUDE.md's Testing section).
//
// KTD1: `invoke()` — not `prepareInvocation()`'s confirmation — is each write tool's real safety
// boundary, since `chat.tools.autoApprove` can bypass the confirmation dialog entirely. Every
// write tool's `invoke()` re-validates its own inputs (non-empty ticket key, non-empty comment
// text, a resolvable issue type, …) independently of whatever `prepareInvocation` showed.
// `confirmationMessages` is always populated for a write tool — never omitted.
//
// KTD5: every write tool's `invoke()` constructs `TicketService` with the same `onDiag` binding
// `JiraParticipant.ts` already uses, so tool-invoked writes are logged to the "Ticket Sidekick"
// output channel the same way chat writes are.
//
// KTD6: tools carry no session memory — every call takes fully-specified parameters (ticket key,
// project key, …). No last-ticket or branch-derived context, unlike the chat participant.
// ---------------------------------------------------------------------------------------------

function textResult(text: string): vscode.LanguageModelToolResult {
  return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
}

interface ConfiguredContext {
  config: JiraConfig & { baseUrl: string; token: string };
  jiraClient: JiraApiClient;
  ticketService: TicketService;
}

/**
 * Resolves the live Jira connection every tool needs, reading config fresh on every call —
 * mirroring `JiraParticipant.ts`'s own per-request construction — rather than caching one
 * long-lived client/service pair, since credentials can be set or changed between tool calls
 * within the same VS Code session. Returns a `LanguageModelToolResult` carrying U1's
 * `buildJiraNotConfiguredMessage(config)` text (R4) when credentials aren't configured, instead
 * of letting a caller reach for `config.baseUrl`/`config.token` on a not-yet-configured config.
 */
async function tryGetConfiguredContext(configService: ConfigService): Promise<ConfiguredContext | vscode.LanguageModelToolResult> {
  const config = await configService.getConfig();
  if (!configService.isConfigured(config)) {
    return textResult(buildJiraNotConfiguredMessage(config));
  }
  const jiraClient = new JiraApiClient({
    baseUrl: config.baseUrl,
    authType: config.authType,
    token: config.token,
    sprintBoardId: config.sprintBoardId,
    onDiag: (level, message, details) => logDiag('jira.apiClient', level, message, details),
  });
  const ticketService = new TicketService(
    jiraClient,
    (level, message, details) => logDiag('jira.ticketService', level, message, details),
  );
  return { config, jiraClient, ticketService };
}

function isNotConfiguredResult(value: ConfiguredContext | vscode.LanguageModelToolResult): value is vscode.LanguageModelToolResult {
  return value instanceof vscode.LanguageModelToolResult;
}

function currentWorkspaceRoot(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
}

// -------------------------------------------------------------------------------------------
// Read tools
// -------------------------------------------------------------------------------------------

interface GetTicketInput {
  ticketKey: string;
}

class GetTicketTool implements vscode.LanguageModelTool<GetTicketInput> {
  constructor(private readonly configService: ConfigService) {}

  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<GetTicketInput>,
  ): Promise<vscode.PreparedToolInvocation> {
    return { invocationMessage: `Fetching ${options.input.ticketKey}…` };
  }

  async invoke(options: vscode.LanguageModelToolInvocationOptions<GetTicketInput>): Promise<vscode.LanguageModelToolResult> {
    const ticketKey = options.input.ticketKey?.trim();
    if (!ticketKey) return textResult('A ticket key is required, e.g. PROJ-123.');
    if (!isSafePathSegment(ticketKey)) return textResult(`"${ticketKey}" is not a valid ticket key.`);

    const ctx = await tryGetConfiguredContext(this.configService);
    if (isNotConfiguredResult(ctx)) return ctx;
    const { config, ticketService } = ctx;

    try {
      const fieldMeta = await ticketService.getFieldMeta();
      const alwaysShowIds = new Set<string>(config.additionalDisplayFields);
      const hiddenIds = new Set<string>(config.hiddenDisplayFields);
      const text = await ticketService.getTicket(ticketKey, fieldMeta, alwaysShowIds, hiddenIds, config.baseUrl);
      return textResult(text);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logDiag('jira.tools', 'error', `jira_getTicket failed — ${ticketKey}`, { ticketKey, error: message });
      return textResult(`Could not fetch ${ticketKey}: ${message}`);
    }
  }
}

interface SearchTicketsInput {
  jql: string;
}

class SearchTicketsTool implements vscode.LanguageModelTool<SearchTicketsInput> {
  constructor(private readonly configService: ConfigService) {}

  async prepareInvocation(): Promise<vscode.PreparedToolInvocation> {
    return { invocationMessage: 'Searching Jira…' };
  }

  async invoke(options: vscode.LanguageModelToolInvocationOptions<SearchTicketsInput>): Promise<vscode.LanguageModelToolResult> {
    const jql = options.input.jql?.trim();
    if (!jql) return textResult('A JQL query is required, e.g. "project = PROJ AND status = \\"In Progress\\"".');

    const ctx = await tryGetConfiguredContext(this.configService);
    if (isNotConfiguredResult(ctx)) return ctx;
    const { config, ticketService } = ctx;

    try {
      const fieldMeta = config.searchFields.length > 0 ? await ticketService.getFieldMeta() : [];
      const text = await ticketService.searchTickets(jql, config.baseUrl, config.searchFields, fieldMeta);
      return textResult(text);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logDiag('jira.tools', 'error', 'jira_searchTickets failed', { jql, error: message });
      return textResult(`Search failed: ${message}`);
    }
  }
}

interface GetCommentsInput {
  ticketKey: string;
  maxResults?: number;
}

class GetCommentsTool implements vscode.LanguageModelTool<GetCommentsInput> {
  constructor(private readonly configService: ConfigService) {}

  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<GetCommentsInput>,
  ): Promise<vscode.PreparedToolInvocation> {
    return { invocationMessage: `Fetching comments on ${options.input.ticketKey}…` };
  }

  async invoke(options: vscode.LanguageModelToolInvocationOptions<GetCommentsInput>): Promise<vscode.LanguageModelToolResult> {
    const ticketKey = options.input.ticketKey?.trim();
    if (!ticketKey) return textResult('A ticket key is required, e.g. PROJ-123.');
    if (!isSafePathSegment(ticketKey)) return textResult(`"${ticketKey}" is not a valid ticket key.`);
    const maxResults = options.input.maxResults && options.input.maxResults > 0 ? options.input.maxResults : 20;

    const ctx = await tryGetConfiguredContext(this.configService);
    if (isNotConfiguredResult(ctx)) return ctx;
    const { ticketService } = ctx;

    try {
      const { comments, total } = await ticketService.getIssueComments(ticketKey, maxResults);
      if (comments.length === 0) return textResult(`No comments on ${ticketKey}.`);
      const header = `## Comments on ${ticketKey} (${total})\n\n`;
      const note = total > comments.length
        ? `\n\n_${total - comments.length} older comment(s) not shown — call again with a larger maxResults to see more._`
        : '';
      return textResult(header + formatCommentsInFull(comments) + note);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logDiag('jira.tools', 'error', `jira_getComments failed — ${ticketKey}`, { ticketKey, error: message });
      return textResult(`Could not fetch comments on ${ticketKey}: ${message}`);
    }
  }
}

// inputSchema is `{ type: 'object', properties: {} }` — no fields to declare.
type ListTemplatesInput = Record<string, never>;

class ListTemplatesTool implements vscode.LanguageModelTool<ListTemplatesInput> {
  constructor(private readonly configService: ConfigService) {}

  async prepareInvocation(): Promise<vscode.PreparedToolInvocation> {
    return { invocationMessage: 'Listing Jira ticket templates…' };
  }

  async invoke(): Promise<vscode.LanguageModelToolResult> {
    const ctx = await tryGetConfiguredContext(this.configService);
    if (isNotConfiguredResult(ctx)) return ctx;

    const workspaceRoot = currentWorkspaceRoot();
    if (!workspaceRoot) return textResult('No workspace folder is open — templates are read from .jira-templates.json in the workspace root.');

    try {
      const { templates } = new TemplateService(workspaceRoot).loadTemplates();
      return textResult(formatTemplateListMessage(templates));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logDiag('jira.tools', 'error', 'jira_listTemplates failed', { error: message });
      return textResult(`Could not load templates: ${message}`);
    }
  }
}

interface DiscoverWorkflowInput {
  projectKey: string;
  issueType: string;
}

class DiscoverWorkflowTool implements vscode.LanguageModelTool<DiscoverWorkflowInput> {
  constructor(private readonly configService: ConfigService) {}

  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<DiscoverWorkflowInput>,
  ): Promise<vscode.PreparedToolInvocation> {
    return { invocationMessage: `Discovering workflow for ${options.input.projectKey} / ${options.input.issueType}…` };
  }

  async invoke(options: vscode.LanguageModelToolInvocationOptions<DiscoverWorkflowInput>): Promise<vscode.LanguageModelToolResult> {
    const projectKey = options.input.projectKey?.trim();
    const issueType = options.input.issueType?.trim();
    if (!projectKey || !issueType) {
      return textResult('Both a project key and an issue type are required, e.g. { "projectKey": "PROJ", "issueType": "Bug" }.');
    }
    if (!isSafePathSegment(projectKey)) return textResult(`"${projectKey}" is not a valid project key.`);

    const ctx = await tryGetConfiguredContext(this.configService);
    if (isNotConfiguredResult(ctx)) return ctx;
    const { jiraClient } = ctx;

    try {
      // Same discover-then-cache sequence the chat 'discoverWorkflow' operation uses
      // (src/participant/jira/workflowHandler.ts, src/services/WorkflowService.ts) — R3.
      const workspaceRoot = currentWorkspaceRoot();
      const { graph, skippedStatuses, preserved } = await discoverAndCacheWorkflow(jiraClient, workspaceRoot, projectKey, issueType);
      if (Object.keys(graph).length === 0) {
        return textResult(formatWorkflowDiscoveryMessage(projectKey, issueType, graph, skippedStatuses, []));
      }

      logDiag('jira.tools', 'info', `Workflow discovered — ${projectKey}/${issueType}`, {
        projectKey, issueType, statusCount: Object.keys(graph).length,
      });
      return textResult(formatWorkflowDiscoveryMessage(projectKey, issueType, graph, skippedStatuses, preserved));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logDiag('jira.tools', 'error', `jira_discoverWorkflow failed — ${projectKey}/${issueType}`, { projectKey, issueType, error: message });
      return textResult(`Could not discover workflow: ${message}`);
    }
  }
}

// -------------------------------------------------------------------------------------------
// Write tools — every one shows an explicit confirmation naming the concrete change (R2), and
// re-validates its own inputs in invoke() regardless of what prepareInvocation() showed (KTD1).
// -------------------------------------------------------------------------------------------

interface AddCommentInput {
  ticketKey: string;
  comment: string;
}

class AddCommentTool implements vscode.LanguageModelTool<AddCommentInput> {
  // Each call posts a new comment (not idempotent) — a retried Agent Mode call with identical
  // input would otherwise post the same comment twice with no reconciliation.
  private readonly recentCalls = new RecentCallGuard();

  constructor(private readonly configService: ConfigService) {}

  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<AddCommentInput>,
  ): Promise<vscode.PreparedToolInvocation> {
    const { ticketKey, comment } = options.input;
    const confirmation = buildAddCommentConfirmation(ticketKey || '(unknown ticket)', comment || '(no comment text given)');
    return {
      invocationMessage: `Adding a comment to ${ticketKey}…`,
      confirmationMessages: confirmation,
    };
  }

  async invoke(options: vscode.LanguageModelToolInvocationOptions<AddCommentInput>): Promise<vscode.LanguageModelToolResult> {
    const ticketKey = options.input.ticketKey?.trim();
    const comment = options.input.comment?.trim();
    if (!ticketKey) return textResult('A ticket key is required, e.g. PROJ-123.');
    if (!isSafePathSegment(ticketKey)) return textResult(`"${ticketKey}" is not a valid ticket key.`);
    if (!comment) return textResult('Comment text is required.');
    const dupeKey = fingerprint(ticketKey, comment);
    if (!this.recentCalls.claim(dupeKey)) {
      return textResult(`Skipped: an identical comment on ${ticketKey} was just posted in the last minute. If this is intentional, change the text or wait before retrying.`);
    }

    const ctx = await tryGetConfiguredContext(this.configService);
    if (isNotConfiguredResult(ctx)) {
      this.recentCalls.release(dupeKey); // not a real attempt — don't block a real retry
      return ctx;
    }
    const { config, ticketService } = ctx;

    try {
      const text = await ticketService.addComment(ticketKey, comment, config.baseUrl);
      return textResult(text);
    } catch (err) {
      this.recentCalls.release(dupeKey); // the write didn't actually happen — a retry isn't a duplicate
      const message = err instanceof Error ? err.message : String(err);
      logDiag('jira.tools', 'error', `jira_addComment failed — ${ticketKey}`, { ticketKey, error: message });
      return textResult(`Could not add comment to ${ticketKey}: ${message}`);
    }
  }
}

interface UpdateFieldInput {
  ticketKey: string;
  fieldName: string;
  value: string;
}

class UpdateFieldTool implements vscode.LanguageModelTool<UpdateFieldInput> {
  constructor(private readonly configService: ConfigService) {}

  // KTD3: reads the ticket's current value for the field before building the confirmation, and
  // shows current → new. Best-effort: a fetch failure (unresolvable field name, unreachable
  // ticket, not-yet-configured credentials) falls back to a placeholder rather than throwing —
  // prepareInvocation() must never throw, and invoke() re-validates everything for real anyway.
  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<UpdateFieldInput>,
  ): Promise<vscode.PreparedToolInvocation> {
    const { ticketKey, fieldName, value } = options.input;
    let currentDisplay = '(current value unavailable)';
    try {
      if (ticketKey && fieldName) {
        const ctx = await tryGetConfiguredContext(this.configService);
        if (!isNotConfiguredResult(ctx)) {
          const { ticketService } = ctx;
          // Fetch field metadata once and hand it to resolveFieldId — it otherwise re-fetches
          // the same `GET /field` list itself for any non-aliased field name.
          const fieldMeta = await ticketService.getFieldMeta();
          const fieldId = await ticketService.resolveFieldId(fieldName, fieldMeta);
          const meta = fieldMeta.find(f => f.id === fieldId);
          const raw = await ticketService.getRawField(ticketKey, fieldId);
          currentDisplay = meta ? renderFieldValue(raw, meta) : (raw === null || raw === undefined ? '_Not set_' : String(raw));
        }
      }
    } catch {
      // Keep the placeholder — see the note above.
    }
    const confirmation = buildUpdateFieldConfirmation(
      ticketKey || '(unknown ticket)', fieldName || '(unknown field)', currentDisplay, value ?? '',
    );
    return {
      invocationMessage: `Updating ${fieldName} on ${ticketKey}…`,
      confirmationMessages: confirmation,
    };
  }

  async invoke(options: vscode.LanguageModelToolInvocationOptions<UpdateFieldInput>): Promise<vscode.LanguageModelToolResult> {
    const ticketKey = options.input.ticketKey?.trim();
    const fieldName = options.input.fieldName?.trim();
    const value = options.input.value ?? '';
    if (!ticketKey) return textResult('A ticket key is required, e.g. PROJ-123.');
    if (!isSafePathSegment(ticketKey)) return textResult(`"${ticketKey}" is not a valid ticket key.`);
    if (!fieldName) return textResult('A field name is required.');

    const ctx = await tryGetConfiguredContext(this.configService);
    if (isNotConfiguredResult(ctx)) return ctx;
    const { config, ticketService } = ctx;

    try {
      // Reuses TicketService.updateField exactly as contentHandler.ts's description-update path
      // does — the same supported-field allowlist and value-shaping logic, no divergent copy.
      const text = await ticketService.updateField(ticketKey, fieldName, value, config.baseUrl);
      return textResult(text);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logDiag('jira.tools', 'error', `jira_updateField failed — ${ticketKey}`, { ticketKey, fieldName, error: message });
      return textResult(`Could not update ${fieldName} on ${ticketKey}: ${message}`);
    }
  }
}

/** Outcome of resolving `templateName` against `.jira-templates.json` for `CreateTicketTool`.
 * `'skip'` covers every reason to fall through to plain issue-type resolution without a template
 * (no workspace open, no templates file, template name not found) — none of those are errors,
 * they just mean "proceed as if templateName weren't given." `'error'` is the one case that must
 * stop ticket creation outright: the template matched but its fields couldn't be resolved. */
type TemplateResolution =
  | { kind: 'resolved'; issueType?: string; fields: Record<string, unknown> }
  | { kind: 'skip' }
  | { kind: 'error'; message: string };

async function resolveTemplateFields(
  jiraClient: JiraApiClient,
  workspaceRoot: string,
  projectKey: string,
  templateName: string,
): Promise<TemplateResolution> {
  if (!workspaceRoot) return { kind: 'skip' };

  let templates;
  try {
    ({ templates } = new TemplateService(workspaceRoot).loadTemplates());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logDiag('jira.tools', 'warn', 'Could not load templates — proceeding without template', { error: message });
    return { kind: 'skip' };
  }

  const template = templates.find(t => t.name === templateName);
  if (!template) {
    logDiag('jira.tools', 'warn', `Template not found — ${templateName}`, { templateName });
    return { kind: 'skip' };
  }

  try {
    const fields = await new FieldResolver(jiraClient, projectKey).resolve(template.defaultFields, template.resolveFields);
    return { kind: 'resolved', issueType: template.issueType, fields };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logDiag('jira.tools', 'warn', `Template field resolution failed — ${templateName}`, { templateName, error: message });
    return { kind: 'error', message: `Could not resolve template "${templateName}"'s fields: ${message}. No ticket was created.` };
  }
}

interface CreateTicketInput {
  projectKey: string;
  summary: string;
  issueType?: string;
  templateName?: string;
  description?: string;
}

class CreateTicketTool implements vscode.LanguageModelTool<CreateTicketInput> {
  // Each call creates a new ticket (not idempotent) — a retried Agent Mode call with identical
  // input would otherwise create a duplicate ticket with no reconciliation.
  private readonly recentCalls = new RecentCallGuard();

  constructor(private readonly configService: ConfigService) {}

  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<CreateTicketInput>,
  ): Promise<vscode.PreparedToolInvocation> {
    const { projectKey, summary, issueType, templateName } = options.input;
    // Best-effort preview of the template's own field values, so approving a template-driven
    // create isn't blind to what the template silently sets — never throws (same rationale as
    // UpdateFieldTool/TransitionTicketTool's live pre-fetch): invoke() resolves (and validates)
    // the template for real regardless of what this preview managed to show.
    let resolvedFields: Record<string, unknown> | null = null;
    if (templateName && projectKey) {
      try {
        const ctx = await tryGetConfiguredContext(this.configService);
        if (!isNotConfiguredResult(ctx)) {
          const templateResult = await resolveTemplateFields(ctx.jiraClient, currentWorkspaceRoot(), projectKey, templateName);
          if (templateResult.kind === 'resolved') resolvedFields = templateResult.fields;
        }
      } catch {
        // Keep resolvedFields null — see the note above.
      }
    }
    const confirmation = buildCreateTicketConfirmation(
      projectKey || '(unknown project)', issueType || null, summary || '(no summary given)', templateName || null, resolvedFields,
    );
    return {
      invocationMessage: `Creating a ticket in ${projectKey}…`,
      confirmationMessages: confirmation,
    };
  }

  // KTD4: never guesses an issue type. When neither `issueType` nor a resolvable `templateName`
  // is given, returns the project's valid issue types (TicketService.getIssueTypes) and creates
  // nothing — see docs/solutions/logic-errors/combined-create-list-silently-guesses-issue-type-
  // and-drops-no-template-fallback.md for the failure mode this must not repeat.
  async invoke(options: vscode.LanguageModelToolInvocationOptions<CreateTicketInput>): Promise<vscode.LanguageModelToolResult> {
    const projectKey = options.input.projectKey?.trim();
    const summary = options.input.summary?.trim();
    const templateName = options.input.templateName?.trim() || undefined;
    const description = options.input.description;
    let issueType = options.input.issueType?.trim() || undefined;

    if (!projectKey) return textResult('A project key is required, e.g. PROJ.');
    if (!summary) return textResult('A summary is required.');
    // Fingerprinted on the raw call inputs (not post-resolution values) — this is about
    // detecting the calling model repeating the same call, not the resolved ticket shape.
    const dupeKey = fingerprint(projectKey, summary, issueType ?? '', templateName ?? '', description ?? '');
    if (!this.recentCalls.claim(dupeKey)) {
      return textResult(`Skipped: an identical ticket in ${projectKey} was just created in the last minute. If this is intentional, change something in the request or wait before retrying.`);
    }
    const release = () => this.recentCalls.release(dupeKey);

    const ctx = await tryGetConfiguredContext(this.configService);
    if (isNotConfiguredResult(ctx)) { release(); return ctx; } // not a real attempt — don't block a real retry
    const { config, jiraClient, ticketService } = ctx;

    let resolvedFields: Record<string, unknown> = {};

    if (templateName) {
      const templateResult = await resolveTemplateFields(jiraClient, currentWorkspaceRoot(), projectKey, templateName);
      if (templateResult.kind === 'error') { release(); return textResult(templateResult.message); }
      if (templateResult.kind === 'resolved') {
        if (!issueType) issueType = templateResult.issueType;
        resolvedFields = templateResult.fields;
      }
      // 'skip' falls through to plain issue-type resolution below, same as templateName not
      // having been given at all.
    }

    if (!issueType) {
      let issueTypes: string[] = [];
      try {
        issueTypes = (await ticketService.getIssueTypes(projectKey)).map(t => t.name);
      } catch (err) {
        logDiag('jira.tools', 'warn', `Could not fetch issue types — ${projectKey}`, {
          projectKey, error: err instanceof Error ? err.message : String(err),
        });
      }
      release(); // no ticket was created — the never-guess fallback isn't a real attempt either
      return textResult(formatIssueTypeOptionsMessage(projectKey, issueTypes));
    }

    if (description) resolvedFields = { ...resolvedFields, description };

    try {
      const created = await ticketService.createTicket(projectKey, summary, issueType, resolvedFields, config.baseUrl);
      return textResult(created.message);
    } catch (err) {
      release(); // the ticket wasn't actually created — a retry isn't a duplicate
      const message = err instanceof Error ? err.message : String(err);
      logDiag('jira.tools', 'error', `jira_createTicket failed — ${projectKey}`, { projectKey, issueType, error: message });
      return textResult(`Could not create ticket: ${message}`);
    }
  }
}

interface TransitionTicketInput {
  ticketKey: string;
  targetStatus: string;
  resolution?: string;
}

class TransitionTicketTool implements vscode.LanguageModelTool<TransitionTicketInput> {
  constructor(private readonly configService: ConfigService) {}

  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<TransitionTicketInput>,
  ): Promise<vscode.PreparedToolInvocation> {
    const { ticketKey, targetStatus, resolution } = options.input;
    let currentStatus: string | null = null;
    try {
      if (ticketKey) {
        const ctx = await tryGetConfiguredContext(this.configService);
        if (!isNotConfiguredResult(ctx)) {
          const issue = await ctx.jiraClient.getIssue(ticketKey);
          currentStatus = issue.fields.status.name;
        }
      }
    } catch {
      // Keep currentStatus null — see UpdateFieldTool's prepareInvocation for the same rationale.
    }
    const confirmation = buildTransitionConfirmation(
      ticketKey || '(unknown ticket)', currentStatus, targetStatus || '(unknown status)', resolution,
    );
    return {
      invocationMessage: `Moving ${ticketKey} to ${targetStatus}…`,
      confirmationMessages: confirmation,
    };
  }

  async invoke(options: vscode.LanguageModelToolInvocationOptions<TransitionTicketInput>): Promise<vscode.LanguageModelToolResult> {
    const ticketKey = options.input.ticketKey?.trim();
    const targetStatus = options.input.targetStatus?.trim();
    const resolution = options.input.resolution?.trim() || undefined;
    if (!ticketKey) return textResult('A ticket key is required, e.g. PROJ-123.');
    if (!isSafePathSegment(ticketKey)) return textResult(`"${ticketKey}" is not a valid ticket key.`);
    if (!targetStatus) return textResult('A target status is required, e.g. "Done".');

    const ctx = await tryGetConfiguredContext(this.configService);
    if (isNotConfiguredResult(ctx)) return ctx;
    const { jiraClient, ticketService } = ctx;

    try {
      // Same resolution algorithm the chat participant's 'transition' operation uses
      // (src/services/WorkflowService.ts) — R3: one implementation, reused everywhere.
      const workspaceRoot = currentWorkspaceRoot();
      const transResult = await resolveAndApplyTransition(jiraClient, ticketService, workspaceRoot, ticketKey, targetStatus, resolution);
      switch (transResult.kind) {
        case 'alreadyThere':
          return textResult(`${ticketKey} is already in ${transResult.currentStatus}.`);
        case 'direct':
          logDiag('jira.tools', 'info', `Transitioned — ${ticketKey} to ${transResult.toStatus}`, { ticketKey, targetStatus: transResult.toStatus });
          return textResult(`${ticketKey} moved to ${transResult.toStatus}.`);
        case 'multiHop':
          logDiag('jira.tools', 'info', `Transitioned — ${ticketKey} to ${targetStatus} (${transResult.hops} hop(s))`, {
            ticketKey, targetStatus, hops: transResult.hops,
          });
          return textResult(`${ticketKey} moved to ${targetStatus} (${transResult.hops} hop${transResult.hops > 1 ? 's' : ''}).`);
        case 'partialFailure':
          logDiag('jira.tools', 'warn', `Partial transition — ${ticketKey} landed at ${transResult.landedStatus}`, {
            ticketKey, targetStatus, completedHops: transResult.completedHops, totalHops: transResult.totalHops, error: transResult.error,
          });
          return textResult(
            `${ticketKey} moved partway to ${transResult.landedStatus} (${transResult.completedHops} of ${transResult.totalHops} hops) ` +
            `but the next step to ${transResult.targetStatus} failed: ${transResult.error} ` +
            `The ticket is now in ${transResult.landedStatus}, not its original status — check its current state before retrying.`,
          );
        case 'unavailable': {
          const available = transResult.available.join(', ');
          const cacheHint = transResult.hasCache
            ? ''
            : ` Call jira_discoverWorkflow for ${transResult.projectKey} / ${transResult.issueType || '<issuetype>'} to enable multi-hop transitions.`;
          return textResult(
            `No transition to ${targetStatus} available from ${transResult.currentStatus}.${available ? ` Available: ${available}.` : ''}${cacheHint}`,
          );
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logDiag('jira.tools', 'error', `jira_transitionTicket failed — ${ticketKey}`, { ticketKey, targetStatus, error: message });
      return textResult(`Could not transition ${ticketKey}: ${message}`);
    }
  }
}

interface LoadTicketInput {
  ticketKey: string;
}

class LoadTicketTool implements vscode.LanguageModelTool<LoadTicketInput> {
  // Writes to workspace disk rather than to Jira, but treated as a write tool requiring
  // confirmation like every other one here (Key Decision) — no `RecentCallGuard`, though
  // (KTD3): a repeat load overwrites the same files, so there's nothing to de-duplicate.
  constructor(private readonly configService: ConfigService) {}

  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<LoadTicketInput>,
  ): Promise<vscode.PreparedToolInvocation> {
    const { ticketKey } = options.input;
    const confirmation = buildLoadTicketConfirmation(ticketKey || '(unknown ticket)');
    return {
      invocationMessage: `Loading ${ticketKey}…`,
      confirmationMessages: confirmation,
    };
  }

  async invoke(options: vscode.LanguageModelToolInvocationOptions<LoadTicketInput>): Promise<vscode.LanguageModelToolResult> {
    const ticketKey = options.input.ticketKey?.trim();
    if (!ticketKey) return textResult('A ticket key is required, e.g. PROJ-123.');
    if (!isSafePathSegment(ticketKey)) return textResult(`"${ticketKey}" is not a valid ticket key.`);

    // R6: checked before any Jira call, mirroring @jira load's own chat message.
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) return textResult('No workspace folder is open. Open a folder to use jira_loadTicket.');

    const ctx = await tryGetConfiguredContext(this.configService);
    if (isNotConfiguredResult(ctx)) return ctx;
    const { config, ticketService } = ctx;

    try {
      // Fetched once here (not inside loadTicketToWorkspace) — this tool has no ticket
      // preview to stream, unlike @jira load, so there's no reason to split the fetch.
      // The three ticketKey-scoped calls are independent, so they run in parallel;
      // getAttachments needs the resolved issue, so it stays outside the batch.
      const [issue, comments, fieldMeta, remoteLinks] = await Promise.all([
        ticketService.getIssue(ticketKey),
        ticketService.getAllComments(ticketKey),
        ticketService.getFieldMeta(),
        ticketService.getRemoteLinks(ticketKey),
      ]);
      const attachments = ticketService.getAttachments(issue);
      const alwaysShowIds = new Set<string>(config.additionalDisplayFields);
      const hiddenIds = new Set<string>(config.hiddenDisplayFields);
      const { downloadedCount, skipped, writeErrors } = await loadTicketToWorkspace(
        ticketKey, ticketService,
        { issue, comments, attachments, remoteLinks },
        { fieldMeta, alwaysShowIds, hiddenIds, baseUrl: config.baseUrl },
        workspaceFolder.uri,
      );
      logDiag('jira.tools', 'info', `Loaded — ${ticketKey}`, { ticketKey, downloadedCount, skippedCount: skipped.length });
      return textResult(buildLoadTicketResultMessage(ticketKey, comments.length, downloadedCount, skipped, writeErrors));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logDiag('jira.tools', 'error', `jira_loadTicket failed — ${ticketKey}`, { ticketKey, error: message });
      return textResult(`Could not load ${ticketKey}: ${message}`);
    }
  }
}

interface DownloadAttachmentInput {
  ticketKey: string;
  filename: string;
}

class DownloadAttachmentTool implements vscode.LanguageModelTool<DownloadAttachmentInput> {
  // No RecentCallGuard (KTD3): a repeat download overwrites the same file, nothing to
  // de-duplicate.
  constructor(private readonly configService: ConfigService) {}

  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<DownloadAttachmentInput>,
  ): Promise<vscode.PreparedToolInvocation> {
    const { ticketKey, filename } = options.input;
    const confirmation = buildDownloadAttachmentConfirmation(ticketKey || '(unknown ticket)', filename || '(unknown file)');
    return {
      invocationMessage: `Downloading ${filename} from ${ticketKey}…`,
      confirmationMessages: confirmation,
    };
  }

  async invoke(options: vscode.LanguageModelToolInvocationOptions<DownloadAttachmentInput>): Promise<vscode.LanguageModelToolResult> {
    const ticketKey = options.input.ticketKey?.trim();
    const filename = options.input.filename?.trim();
    if (!ticketKey) return textResult('A ticket key is required, e.g. PROJ-123.');
    if (!isSafePathSegment(ticketKey)) return textResult(`"${ticketKey}" is not a valid ticket key.`);
    if (!filename) return textResult('A filename is required, e.g. error.log.');
    if (!isSafePathSegment(filename)) return textResult(`"${filename}" is not a valid filename.`);

    // R10: checked before any Jira call, mirroring jira_loadTicket/@jira load.
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) return textResult('No workspace folder is open. Open a folder to use jira_downloadAttachment.');

    const ctx = await tryGetConfiguredContext(this.configService);
    if (isNotConfiguredResult(ctx)) return ctx;
    const { ticketService } = ctx;

    try {
      // KTD5: always re-derives the ticket's attachment list live — no session/cache of a
      // prior load's skip list — so this works whether or not a load ever ran for this ticket.
      const issue = await ticketService.getIssue(ticketKey);
      const attachments = ticketService.getAttachments(issue);
      const { attachment, matchCount } = findAttachmentByFilename(attachments, filename);
      if (!attachment) {
        return textResult(buildAttachmentNotFoundMessage(ticketKey, filename, attachments.map(a => a.filename)));
      }
      if (attachment.size > ATTACHMENT_SIZE_LIMIT) {
        return textResult(`"${filename}" is ${formatFileSize(attachment.size)}, over the 100 MB size limit — not downloaded.`);
      }

      const bytes = await ticketService.downloadAttachment(attachment.content);
      const attachmentsDir = attachmentsDirFor(workspaceFolder.uri, ticketKey);
      await vscode.workspace.fs.createDirectory(attachmentsDir);
      await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(attachmentsDir, filename), bytes);
      await ensureJiraContextGitignored(workspaceFolder.uri);

      logDiag('jira.tools', 'info', `Downloaded attachment — ${ticketKey}/${filename}`, { ticketKey, filename, matchCount });
      return textResult(buildDownloadAttachmentResultMessage(ticketKey, filename, matchCount));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logDiag('jira.tools', 'error', `jira_downloadAttachment failed — ${ticketKey}/${filename}`, { ticketKey, filename, error: message });
      return textResult(`Could not download ${filename} from ${ticketKey}: ${message}`);
    }
  }
}

/** Registers every `jira_*` Language Model tool with VS Code (matching the `name`s declared under
 * `contributes.languageModelTools` in package.json) and ties their disposal to the extension's
 * lifecycle via `context.subscriptions`. Called once from `activate()` in `extension.ts`. */
export function registerJiraTools(context: vscode.ExtensionContext, configService: ConfigService): void {
  context.subscriptions.push(
    vscode.lm.registerTool('jira_getTicket', new GetTicketTool(configService)),
    vscode.lm.registerTool('jira_searchTickets', new SearchTicketsTool(configService)),
    vscode.lm.registerTool('jira_getComments', new GetCommentsTool(configService)),
    vscode.lm.registerTool('jira_listTemplates', new ListTemplatesTool(configService)),
    vscode.lm.registerTool('jira_discoverWorkflow', new DiscoverWorkflowTool(configService)),
    vscode.lm.registerTool('jira_addComment', new AddCommentTool(configService)),
    vscode.lm.registerTool('jira_updateField', new UpdateFieldTool(configService)),
    vscode.lm.registerTool('jira_createTicket', new CreateTicketTool(configService)),
    vscode.lm.registerTool('jira_transitionTicket', new TransitionTicketTool(configService)),
    vscode.lm.registerTool('jira_loadTicket', new LoadTicketTool(configService)),
    vscode.lm.registerTool('jira_downloadAttachment', new DownloadAttachmentTool(configService)),
  );
}
