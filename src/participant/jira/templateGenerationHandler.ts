// Shared, vscode-dependent session-flow orchestration for the template-generation chat flow.
// Mirrors reportImportHandler.ts's overall shape (build session -> stream review -> confirm -> act),
// adapted from "reviewing report rows" to "reviewing candidate template fields": build candidates ->
// review list (toggle/set-value) -> save (with name-collision handling) -> offer to
// create a first ticket. All pure logic (session shapes, the parseReviewInput setValue
// extension, table rendering, reply parsing) lives in sessionState.ts so it stays Vitest-loadable
// per CLAUDE.md's testing rule — this file is the vscode-coupled glue only.
//
// `baseUrl` (for formatKeyLink-style ticket links) is only ever consumed by createFirstTicket() —
// it's accepted directly by the two entry points that can reach it (handleOfferCreateReply,
// handleAwaitSummaryReply) rather than threaded through every earlier session-building/review
// function that never uses it, matching how each of this flow's reply-handling entry points
// already receives its own fresh parameters from the caller rather than pulling them back out
// of session state.
import * as vscode from 'vscode';
import { logDiag } from '../../utils/diagLog';
import { TicketService, type TemplateFieldCandidate } from '../../services/TicketService';
import { TemplateService, type JiraTemplate } from '../../templates/TemplateService';
import {
  isCancellation, isSessionExpired, SESSION_EXPIRED_MESSAGE, CURRENT_SESSION_SCHEMA_VERSION,
  filterOutPerTicketFields, buildTemplateFieldReviewRows, buildTemplateFieldReviewTable,
  findUnsetIncludedRows, buildGeneratedTemplate,
  extractProjectKeyFromTicketKey, parseIssueTypePick, parseTemplateCollisionReply, parseOfferCreateReply,
  parseReviewInput, applyReviewToggle, applyReviewSetValue,
  type TemplateGenerationTypePickSession, type TemplateGenerationReviewSession,
  type TemplateGenerationCollisionSession, type TemplateGenerationOfferCreateSession,
  type TemplateGenerationAwaitSummarySession,
} from '../sessionState';
import { resolveProjectKey } from './ticketContext';

const SCOPE = 'jira.templateGeneration';

// workspaceState keys + response tags for this flow's five session states (CLAUDE.md's multi-turn
// session convention). Exported so the routing layer in JiraParticipant.ts can detect the tag in
// the last assistant response and load the matching session without hardcoding these literals
// separately from this file.
export const TEMPLATE_GEN_SESSION_KEYS = {
  typePick: 'jira.session.templateGenTypePick',
  review: 'jira.session.templateGenReview',
  collision: 'jira.session.templateGenCollision',
  offerCreate: 'jira.session.templateGenOfferCreate',
  awaitSummary: 'jira.session.templateGenAwaitSummary',
} as const;

export const TEMPLATE_GEN_TAGS = {
  typePick: '<!-- jira:template-gen-type-pick -->',
  review: '<!-- jira:template-gen-review -->',
  collision: '<!-- jira:template-gen-collision -->',
  offerCreate: '<!-- jira:template-gen-offer-create -->',
  awaitSummary: '<!-- jira:template-gen-await-summary -->',
} as const;

// What the routing layer's parsed intent supplies. templateName/issueTypeHint may be null — this
// flow resolves both interactively (a showInputBox for the name, a pick-list for the issue type)
// rather than requiring the LLM intent parser to have extracted them. sourceTicketKey null means
// the no-reference path; non-null means the reference-ticket path.
export interface TemplateGenerationRequest {
  templateName: string | null;
  projectKeyHint: string | null;
  sourceTicketKey: string | null;
  issueTypeHint: string | null;
}

/**
 * Entry point for the "generate a template" operation. Resolves whatever
 * the parsed intent didn't supply (template name via input box; project key via the shared
 * resolveProjectKey helper on the no-reference path; issue type via a pick-list when the
 * no-reference path didn't name one), then fetches candidates and streams the review list.
 */
export async function handleGenerateTemplate(
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
  ticketService: TicketService,
  workspaceRoot: string,
  hiddenDisplayFields: string[],
  request: TemplateGenerationRequest,
): Promise<void> {
  let templateName = request.templateName;
  if (!templateName) {
    const entered = (await vscode.window.showInputBox({
      prompt: 'Name for the new template',
      placeHolder: 'e.g. Billing Bug',
      ignoreFocusOut: true,
    })) ?? null;
    if (!entered) { stream.markdown('_No template name provided — cancelled._'); return; }
    templateName = entered;
  }

  if (request.sourceTicketKey) {
    await startFromReferenceTicket(templateName, request.sourceTicketKey, ticketService, hiddenDisplayFields, stream, ws);
    return;
  }

  const projectKey = await resolveProjectKey(request.projectKeyHint, stream);
  if (!projectKey) { stream.markdown('_No project key provided — cancelled._'); return; }

  // Fetch the project's real issue types up front, whether or not the request named one — an
  // unnamed type needs the pick-list below, and a named one still needs validating against this
  // same list: an unmatched name (LLM extraction drift, a typo, "Bug" vs "Software Bug") must not
  // be trusted as-is, since getRequiredFields silently returns no fields for an unknown type,
  // which would otherwise produce an empty, un-flagged review list ready to save.
  let issueTypes: string[] = [];
  try {
    issueTypes = (await ticketService.getIssueTypes(projectKey)).map(t => t.name);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logDiag(SCOPE, 'warn', `Could not fetch issue types — ${projectKey}`, { projectKey, error: message });
  }

  if (request.issueTypeHint) {
    const matched = issueTypes.find(t => t.toLowerCase() === request.issueTypeHint!.toLowerCase());
    if (matched) {
      await startFromRequiredFields(templateName, projectKey, matched, ticketService, stream, ws);
      return;
    }
    stream.markdown(`_"${request.issueTypeHint}" isn't one of **${projectKey}**'s issue types — pick from the list instead._\n\n`);
    // Falls through to the pick-list (or input-box) flow below, same as no hint at all.
  }

  // The no-reference path has no resolvable issue type yet — ask the user to pick one from the
  // project's available types before fetching required-fields metadata.
  // getTemplateCandidatesFromRequiredFields takes issue type as a mandatory, already-resolved
  // input and does no prompting itself; this is the one vscode-coupled layer allowed to prompt.
  if (issueTypes.length === 0) {
    // No resolvable issue type from any real source — an input box, never a guessed default
    // (see docs/solutions/logic-errors/combined-create-list-silently-guesses-issue-type…).
    stream.markdown('_Could not fetch issue types — opening input box…_\n\n');
    const entered = (await vscode.window.showInputBox({
      prompt: 'Enter the issue type (e.g. Bug, Story, Task)',
      ignoreFocusOut: true,
    })) ?? null;
    if (!entered) { stream.markdown('_No issue type provided — cancelled._'); return; }
    await startFromRequiredFields(templateName, projectKey, entered, ticketService, stream, ws);
    return;
  }

  const typePickSession: TemplateGenerationTypePickSession = {
    templateName, projectKey, availableIssueTypes: issueTypes, schemaVersion: CURRENT_SESSION_SCHEMA_VERSION,
  };
  await streamTypePick(typePickSession, stream, ws);
}

async function startFromReferenceTicket(
  templateName: string,
  sourceTicketKey: string,
  ticketService: TicketService,
  hiddenDisplayFields: string[],
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
): Promise<void> {
  // getTemplateCandidatesFromTicket's candidate extraction fetches the issue itself but returns
  // only template-shaped fields — issuetype is never in that allowlist, so it's read here from
  // the raw issue instead of asking that method for it. This does mean the reference ticket is
  // fetched twice (once here, once inside getTemplateCandidatesFromTicket) — accepted since its
  // interface has no way to pass an already-fetched issue in, and this flow only runs once per
  // template generation, not in a loop.
  let issueType: string;
  let projectKey: string;
  try {
    const issue = await ticketService.getIssue(sourceTicketKey);
    const rawIssueType = issue.fields.issuetype as { name?: string } | undefined;
    issueType = rawIssueType?.name ?? '';
    projectKey = extractProjectKeyFromTicketKey(sourceTicketKey) ?? issue.key.split('-')[0] ?? '';
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logDiag(SCOPE, 'error', `Could not fetch reference ticket — ${sourceTicketKey}`, { ticketKey: sourceTicketKey, error: message });
    stream.markdown(`_Could not fetch ${sourceTicketKey}: ${message}_`);
    return;
  }
  if (!issueType || !projectKey) {
    stream.markdown(`_Could not determine ${sourceTicketKey}'s issue type or project — cancelled._`);
    return;
  }

  let candidates: TemplateFieldCandidate[];
  try {
    const hiddenIds = new Set<string>(hiddenDisplayFields);
    candidates = await ticketService.getTemplateCandidatesFromTicket(sourceTicketKey, undefined, hiddenIds);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logDiag(SCOPE, 'error', `Could not fetch template candidates — ${sourceTicketKey}`, { ticketKey: sourceTicketKey, error: message });
    stream.markdown(`_Could not fetch fields from ${sourceTicketKey}: ${message}_`);
    return;
  }

  const rows = buildTemplateFieldReviewRows(candidates);
  const reviewSession: TemplateGenerationReviewSession = {
    templateName, projectKey, issueType, sourceTicketKey, rows, schemaVersion: CURRENT_SESSION_SCHEMA_VERSION,
  };
  await streamReview(reviewSession, stream, ws);
}

async function startFromRequiredFields(
  templateName: string,
  projectKey: string,
  issueType: string,
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
): Promise<void> {
  let candidates: TemplateFieldCandidate[];
  try {
    candidates = await ticketService.getTemplateCandidatesFromRequiredFields(projectKey, issueType);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logDiag(SCOPE, 'error', `Could not fetch required fields — ${projectKey}/${issueType}`, { projectKey, issueType, error: message });
    stream.markdown(`_Could not fetch required fields for **${issueType}** in **${projectKey}**: ${message}_`);
    return;
  }

  const rows = buildTemplateFieldReviewRows(filterOutPerTicketFields(candidates));
  const reviewSession: TemplateGenerationReviewSession = {
    templateName, projectKey, issueType, sourceTicketKey: null, rows, schemaVersion: CURRENT_SESSION_SCHEMA_VERSION,
  };
  await streamReview(reviewSession, stream, ws);
}

// --- Issue-type pick list (no-reference path, no type named) ---

export async function streamTypePick(
  session: TemplateGenerationTypePickSession,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
): Promise<void> {
  await ws.update(TEMPLATE_GEN_SESSION_KEYS.typePick, session);
  const list = session.availableIssueTypes.map((t, i) => `${i + 1}. ${t}`).join('\n');
  stream.markdown(
    `Generating template **${session.templateName}** for project **${session.projectKey}** — which issue type?\n\n` +
    `${list}\n\nReply with a number, or **(c)** to cancel.\n\n${TEMPLATE_GEN_TAGS.typePick}`,
  );
}

export async function handleTypePickReply(
  reply: string,
  session: TemplateGenerationTypePickSession,
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
): Promise<void> {
  if (isSessionExpired(session)) {
    await ws.update(TEMPLATE_GEN_SESSION_KEYS.typePick, undefined);
    stream.markdown(SESSION_EXPIRED_MESSAGE);
    return;
  }

  const pick = parseIssueTypePick(reply, session.availableIssueTypes);
  if (pick === 'cancel') {
    await ws.update(TEMPLATE_GEN_SESSION_KEYS.typePick, undefined);
    stream.markdown('_Cancelled — no template was saved._');
    return;
  }
  if (pick === 'invalid') {
    stream.markdown(`Didn't understand that. Reply with a number, or **(c)** to cancel.\n\n${TEMPLATE_GEN_TAGS.typePick}`);
    return;
  }

  await ws.update(TEMPLATE_GEN_SESSION_KEYS.typePick, undefined);
  await startFromRequiredFields(session.templateName, session.projectKey, pick, ticketService, stream, ws);
}

// --- Review list (toggle / setValue / confirm) ---

export async function streamReview(
  session: TemplateGenerationReviewSession,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
): Promise<void> {
  await ws.update(TEMPLATE_GEN_SESSION_KEYS.review, session);
  const sourceLine = session.sourceTicketKey
    ? `_Generating from **${session.sourceTicketKey}**._`
    : `_Generating from **${session.projectKey}**'s required fields for **${session.issueType}**._`;
  stream.markdown(`${sourceLine}\n\n${buildTemplateFieldReviewTable(session.rows)}\n\n${TEMPLATE_GEN_TAGS.review}`);
}

export async function handleTemplateGenReviewReply(
  reply: string,
  session: TemplateGenerationReviewSession,
  workspaceRoot: string,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
): Promise<void> {
  if (isSessionExpired(session)) {
    await ws.update(TEMPLATE_GEN_SESSION_KEYS.review, undefined);
    stream.markdown(SESSION_EXPIRED_MESSAGE);
    return;
  }

  const rowIds = session.rows.map(r => r.id);
  const decision = parseReviewInput(reply, rowIds);

  if (decision.action === 'invalid') {
    stream.markdown(
      `Didn't understand that. Reply **post it** to save, **(c)** to cancel, row numbers to toggle ` +
      `(e.g. \`2 4\`), or \`<number>=<value>\` to set a value (e.g. \`3=High\`).\n\n${TEMPLATE_GEN_TAGS.review}`,
    );
    return;
  }
  if (decision.action === 'cancel') {
    await ws.update(TEMPLATE_GEN_SESSION_KEYS.review, undefined);
    stream.markdown('_Cancelled — no template was saved._');
    return;
  }
  if (decision.action === 'toggle') {
    session.rows = applyReviewToggle(session.rows, decision.ids);
    await streamReview(session, stream, ws);
    return;
  }
  if (decision.action === 'setValue') {
    session.rows = applyReviewSetValue(session.rows, decision.id, decision.value);
    await streamReview(session, stream, ws);
    return;
  }

  // decision.action === 'ok' — a required field with no value to copy is filled inline in this
  // same review step, so a confirm with an included-but-still-unset row re-prompts instead
  // of silently saving it blank or silently dropping it from the template.
  const unset = findUnsetIncludedRows(session.rows);
  if (unset.length > 0) {
    const names = unset.map(r => `**${r.name}** (reply \`${r.id}=<value>\`)`).join(', ');
    stream.markdown(
      `These included fields still need a value before saving: ${names}.\n\n` +
      `${buildTemplateFieldReviewTable(session.rows)}\n\n${TEMPLATE_GEN_TAGS.review}`,
    );
    return;
  }

  await ws.update(TEMPLATE_GEN_SESSION_KEYS.review, undefined);
  const template = buildGeneratedTemplate(session.templateName, session.issueType, session.rows);
  await attemptSave(template, session.projectKey, workspaceRoot, stream, ws, false);
}

// --- Save + name-collision handling ---

async function attemptSave(
  template: JiraTemplate,
  projectKey: string,
  workspaceRoot: string,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
  overwrite: boolean,
): Promise<void> {
  if (!workspaceRoot) {
    stream.markdown('_No workspace folder is open — cannot save a template. Open a folder and try again._');
    return;
  }

  let result;
  try {
    result = new TemplateService(workspaceRoot).saveTemplate(template, { overwrite });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logDiag(SCOPE, 'error', `Could not save template — ${template.name}`, { templateName: template.name, error: message });
    stream.markdown(`_Could not save template: ${message}_`);
    return;
  }

  if (result.status === 'collision') {
    // Never silently overwrite — the reviewed field set is preserved on `template` itself
    // (already fully built) while the user picks a different name or explicitly confirms.
    const collisionSession: TemplateGenerationCollisionSession = {
      template, projectKey, schemaVersion: CURRENT_SESSION_SCHEMA_VERSION,
    };
    await streamCollision(collisionSession, stream, ws);
    return;
  }

  logDiag(SCOPE, 'info', `Template saved — ${template.name}`, { templateName: template.name, issueType: template.issueType });
  const offerSession: TemplateGenerationOfferCreateSession = {
    template: result.template, projectKey, schemaVersion: CURRENT_SESSION_SCHEMA_VERSION,
  };
  await streamOfferCreate(offerSession, stream, ws);
}

export async function streamCollision(
  session: TemplateGenerationCollisionSession,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
): Promise<void> {
  await ws.update(TEMPLATE_GEN_SESSION_KEYS.collision, session);
  stream.markdown(
    `A template named **${session.template.name}** already exists. Reply with a different name to save ` +
    `under, **yes** to overwrite the existing one, or **(c)** to cancel.\n\n${TEMPLATE_GEN_TAGS.collision}`,
  );
}

export async function handleTemplateGenCollisionReply(
  reply: string,
  session: TemplateGenerationCollisionSession,
  workspaceRoot: string,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
): Promise<void> {
  if (isSessionExpired(session)) {
    await ws.update(TEMPLATE_GEN_SESSION_KEYS.collision, undefined);
    stream.markdown(SESSION_EXPIRED_MESSAGE);
    return;
  }

  const decision = parseTemplateCollisionReply(reply);
  if (decision.action === 'invalid') {
    stream.markdown(`Didn't understand that.\n\n`);
    await streamCollision(session, stream, ws);
    return;
  }
  if (decision.action === 'cancel') {
    await ws.update(TEMPLATE_GEN_SESSION_KEYS.collision, undefined);
    stream.markdown('_Cancelled — no template was saved._');
    return;
  }

  await ws.update(TEMPLATE_GEN_SESSION_KEYS.collision, undefined);
  if (decision.action === 'overwrite') {
    await attemptSave(session.template, session.projectKey, workspaceRoot, stream, ws, true);
    return;
  }
  // decision.action === 'rename'
  const renamed: JiraTemplate = { ...session.template, name: decision.name };
  await attemptSave(renamed, session.projectKey, workspaceRoot, stream, ws, false);
}

// --- Offer to create a first ticket ---

export async function streamOfferCreate(
  session: TemplateGenerationOfferCreateSession,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
): Promise<void> {
  await ws.update(TEMPLATE_GEN_SESSION_KEYS.offerCreate, session);
  stream.markdown(
    `Template **${session.template.name}** saved.\n\nCreate a first ticket from it now? Reply with a ` +
    `summary to create one, or **no** to skip.\n\n${TEMPLATE_GEN_TAGS.offerCreate}`,
  );
}

export async function handleOfferCreateReply(
  reply: string,
  session: TemplateGenerationOfferCreateSession,
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
  baseUrl?: string,
): Promise<void> {
  if (isSessionExpired(session)) {
    await ws.update(TEMPLATE_GEN_SESSION_KEYS.offerCreate, undefined);
    stream.markdown(SESSION_EXPIRED_MESSAGE);
    return;
  }

  const decision = parseOfferCreateReply(reply);
  if (decision.action === 'decline') {
    await ws.update(TEMPLATE_GEN_SESSION_KEYS.offerCreate, undefined);
    stream.markdown('_No ticket created — the template is saved and ready to use._');
    return;
  }
  if (decision.action === 'needSummary') {
    await ws.update(TEMPLATE_GEN_SESSION_KEYS.offerCreate, undefined);
    const summarySession: TemplateGenerationAwaitSummarySession = {
      template: session.template, projectKey: session.projectKey, schemaVersion: CURRENT_SESSION_SCHEMA_VERSION,
    };
    await streamAwaitSummary(summarySession, stream, ws);
    return;
  }

  // decision.action === 'create'
  await ws.update(TEMPLATE_GEN_SESSION_KEYS.offerCreate, undefined);
  await createFirstTicket(session.template, session.projectKey, decision.summary, ticketService, stream, baseUrl);
}

export async function streamAwaitSummary(
  session: TemplateGenerationAwaitSummarySession,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
): Promise<void> {
  await ws.update(TEMPLATE_GEN_SESSION_KEYS.awaitSummary, session);
  stream.markdown(`What should the summary be?\n\n${TEMPLATE_GEN_TAGS.awaitSummary}`);
}

export async function handleAwaitSummaryReply(
  reply: string,
  session: TemplateGenerationAwaitSummarySession,
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
  baseUrl?: string,
): Promise<void> {
  if (isSessionExpired(session)) {
    await ws.update(TEMPLATE_GEN_SESSION_KEYS.awaitSummary, undefined);
    stream.markdown(SESSION_EXPIRED_MESSAGE);
    return;
  }

  if (isCancellation(reply)) {
    await ws.update(TEMPLATE_GEN_SESSION_KEYS.awaitSummary, undefined);
    stream.markdown('_No ticket created — the template is saved and ready to use._');
    return;
  }
  const summary = reply.trim();
  if (!summary) {
    stream.markdown(`What should the summary be?\n\n${TEMPLATE_GEN_TAGS.awaitSummary}`);
    return;
  }

  await ws.update(TEMPLATE_GEN_SESSION_KEYS.awaitSummary, undefined);
  await createFirstTicket(session.template, session.projectKey, summary, ticketService, stream, baseUrl);
}

async function createFirstTicket(
  template: JiraTemplate,
  projectKey: string,
  summary: string,
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
  baseUrl?: string,
): Promise<void> {
  // A generated template always resolves and stores its own issueType before it's ever built
  // (see handleGenerateTemplate/startFromReferenceTicket/startFromRequiredFields) — a missing one
  // here would mean a hand-edited or otherwise foreign template reached this path unexpectedly.
  // Never guess one (per docs/solutions/logic-errors/combined-create-list-silently-guesses-issue-type…):
  // surface it instead of silently defaulting to e.g. 'Task'.
  if (!template.issueType) {
    stream.markdown('_Could not create a ticket: the saved template has no issue type recorded._');
    return;
  }
  try {
    const created = await ticketService.createTicket(projectKey, summary, template.issueType, template.defaultFields, baseUrl);
    // Real success point (KTD9): createTicket resolved without throwing — a walkthrough step
    // watching this must never fire on an attempted-but-failed create.
    await vscode.commands.executeCommand('setContext', 'ticketSidekick.firstTicketCreated', true);
    stream.markdown(created.message);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logDiag(SCOPE, 'error', `Ticket creation from generated template failed — ${template.name}`, {
      templateName: template.name, projectKey, error: message,
    });
    stream.markdown(`_Could not create ticket: ${message}_`);
  }
}
