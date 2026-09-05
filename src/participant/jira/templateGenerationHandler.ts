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
  buildEmptyRequiredFieldsWarning,
  findUnsetIncludedRows, buildGeneratedTemplate,
  extractProjectKeyFromTicketKey, parseIssueTypePick, parseTemplateCollisionReply, parseOfferCreateReply,
  parseAwaitFreeTextReply,
  parseReviewInput, applyReviewToggle, applyReviewSetValue, buildChatCommandLink,
  type TemplateGenerationAwaitNameSession, type TemplateGenerationTypePickSession,
  type TemplateGenerationAwaitFreeTypeSession, type TemplateGenerationReviewSession,
  type TemplateGenerationCollisionSession, type TemplateGenerationOfferCreateSession,
  type TemplateGenerationAwaitSummarySession, type JiraSessionKind,
} from '../sessionState';
import { resolveProjectKey } from './ticketContext';
import type { JiraIssueType } from '../../jira/IJiraClient';
import { trustedChatMarkdown } from '../../utils/chatMarkdown';

const SCOPE = 'jira.templateGeneration';

// workspaceState keys + response tags for this flow's seven session states (CLAUDE.md's multi-turn
// session convention). Exported so the routing layer in JiraParticipant.ts can detect the tag in
// the last assistant response and load the matching session without hardcoding these literals
// separately from this file.
export const TEMPLATE_GEN_SESSION_KEYS = {
  awaitName: 'jira.session.templateGenAwaitName',
  typePick: 'jira.session.templateGenTypePick',
  awaitFreeType: 'jira.session.templateGenAwaitFreeType',
  review: 'jira.session.templateGenReview',
  collision: 'jira.session.templateGenCollision',
  offerCreate: 'jira.session.templateGenOfferCreate',
  awaitSummary: 'jira.session.templateGenAwaitSummary',
} as const;

// U4: liveness is now detected via ChatResult.metadata (getActiveJiraSession in ticketContext.ts),
// not a visible response tag — each session state maps to its JiraSessionKind literal, spelled out
// so a typo here is a compile error. Exported so JiraParticipant.ts's routing layer can detect the
// active kind without hardcoding these literals separately from this file.
export const TEMPLATE_GEN_KINDS = {
  awaitName: 'template-gen-await-name',
  typePick: 'template-gen-type-pick',
  awaitFreeType: 'template-gen-await-free-type',
  review: 'template-gen-review',
  collision: 'template-gen-collision',
  offerCreate: 'template-gen-offer-create',
  awaitSummary: 'template-gen-await-summary',
} as const satisfies Record<string, JiraSessionKind>;

// What the routing layer's parsed intent supplies. templateName/issueTypeHint may be null — this
// flow resolves both interactively, in chat (a reply-and-continue ask for the name, a pick-list or
// reply-and-continue ask for the issue type) rather than requiring the LLM intent parser to have
// extracted them. sourceTicketKey null means the no-reference path; non-null means the
// reference-ticket path.
export interface TemplateGenerationRequest {
  templateName: string | null;
  projectKeyHint: string | null;
  sourceTicketKey: string | null;
  issueTypeHint: string | null;
}

/**
 * Entry point for the "generate a template" operation. When the parsed intent already supplied a
 * template name, resolves the rest of the request synchronously via continueGenerateTemplate();
 * otherwise detours to a chat-ask for the name (R2 — see streamAwaitName/handleAwaitNameReply)
 * and resumes into that same continuation once the reply arrives, instead of blocking on a
 * showInputBox.
 */
export async function handleGenerateTemplate(
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
  ticketService: TicketService,
  workspaceRoot: string,
  hiddenDisplayFields: string[],
  request: TemplateGenerationRequest,
): Promise<vscode.ChatResult | void> {
  if (!request.templateName) {
    const awaitNameSession: TemplateGenerationAwaitNameSession = {
      projectKeyHint: request.projectKeyHint,
      sourceTicketKey: request.sourceTicketKey,
      issueTypeHint: request.issueTypeHint,
      schemaVersion: CURRENT_SESSION_SCHEMA_VERSION,
    };
    return streamAwaitName(awaitNameSession, stream, ws);
  }

  return continueGenerateTemplate(request.templateName, request, ticketService, workspaceRoot, hiddenDisplayFields, stream, ws);
}

/**
 * Continuation of handleGenerateTemplate() once templateName is known — either supplied directly
 * in the original request, or resolved via R2's chat-ask (handleAwaitNameReply). Resolves the
 * reference-ticket path, or the no-reference path's project key + issue type (pick-list, or R3's
 * chat-ask when the type list can't be fetched — see streamAwaitFreeType/handleAwaitFreeTypeReply),
 * then fetches candidates and streams the review list. Factored out of handleGenerateTemplate so
 * both the "name already given" path and the "name arrived via chat reply" resume path share it.
 */
async function continueGenerateTemplate(
  templateName: string,
  request: Omit<TemplateGenerationRequest, 'templateName'>,
  ticketService: TicketService,
  workspaceRoot: string,
  hiddenDisplayFields: string[],
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
): Promise<vscode.ChatResult | void> {
  if (request.sourceTicketKey) {
    return startFromReferenceTicket(templateName, request.sourceTicketKey, ticketService, hiddenDisplayFields, stream, ws);
  }

  const projectKey = await resolveProjectKey(request.projectKeyHint, stream);
  if (!projectKey) { stream.markdown('_No project key provided — cancelled._'); return; }

  // Fetch the project's real issue types up front, whether or not the request named one — an
  // unnamed type needs the pick-list below, and a named one still needs validating against this
  // same list: an unmatched name (LLM extraction drift, a typo, "Bug" vs "Software Bug") must not
  // be trusted as-is, since getRequiredFields silently returns no fields for an unknown type,
  // which would otherwise produce an empty, un-flagged review list ready to save.
  let issueTypes: JiraIssueType[] = [];
  try {
    issueTypes = await ticketService.getIssueTypes(projectKey);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logDiag(SCOPE, 'warn', `Could not fetch issue types — ${projectKey}`, { projectKey, error: message });
  }

  if (request.issueTypeHint) {
    const matched = issueTypes.find(t => t.name.toLowerCase() === request.issueTypeHint!.toLowerCase());
    if (matched) {
      return startFromRequiredFields(templateName, projectKey, matched.name, ticketService, stream, ws, matched.id);
    }
    stream.markdown(`_"${request.issueTypeHint}" isn't one of **${projectKey}**'s issue types — pick from the list instead._\n\n`);
    // Falls through to the pick-list (or chat-ask) flow below, same as no hint at all.
  }

  // The no-reference path has no resolvable issue type yet — ask the user to pick one from the
  // project's available types before fetching required-fields metadata.
  // getTemplateCandidatesFromRequiredFields takes issue type as a mandatory, already-resolved
  // input and does no prompting itself; this is the one layer allowed to prompt (in chat, R2/R3).
  if (issueTypes.length === 0) {
    // No resolvable issue type from any real source — ask via chat, never a guessed default
    // (see docs/solutions/logic-errors/combined-create-list-silently-guesses-issue-type…).
    const awaitTypeSession: TemplateGenerationAwaitFreeTypeSession = {
      templateName, projectKey, schemaVersion: CURRENT_SESSION_SCHEMA_VERSION,
    };
    return streamAwaitFreeType(awaitTypeSession, stream, ws);
  }

  const typePickSession: TemplateGenerationTypePickSession = {
    templateName, projectKey, availableIssueTypes: issueTypes, schemaVersion: CURRENT_SESSION_SCHEMA_VERSION,
  };
  return streamTypePick(typePickSession, stream, ws);
}

// --- Template name chat-ask (R2: a chat reply-and-continue step, not a showInputBox) ---

export async function streamAwaitName(
  session: TemplateGenerationAwaitNameSession,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
): Promise<vscode.ChatResult> {
  await ws.update(TEMPLATE_GEN_SESSION_KEYS.awaitName, session);
  // KTD3: this ask's cancel check is isExplicitCancelToken() (literal "(c)"), not isCancellation()'s
  // broader word list — the link resubmits "(c)" itself so the click reproduces exactly what
  // already works, without touching that parser (Risks section).
  stream.markdown(trustedChatMarkdown(
    `What should the new template be named?\n\nReply with a name, or ${buildChatCommandLink('Cancel', '@jira', '(c)')}.`,
  ));
  return { metadata: { jiraSession: { kinds: [TEMPLATE_GEN_KINDS.awaitName] } } };
}

export async function handleAwaitNameReply(
  reply: string,
  session: TemplateGenerationAwaitNameSession,
  ticketService: TicketService,
  workspaceRoot: string,
  hiddenDisplayFields: string[],
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
): Promise<vscode.ChatResult | void> {
  if (isSessionExpired(session)) {
    await ws.update(TEMPLATE_GEN_SESSION_KEYS.awaitName, undefined);
    stream.markdown(SESSION_EXPIRED_MESSAGE);
    return;
  }

  // KTD3: only an explicit "(c)" cancels here, not isCancellation()'s broader word list — see
  // parseAwaitFreeTextReply's doc comment in sessionState.ts.
  const parsed = parseAwaitFreeTextReply(reply);
  if (parsed.action === 'cancel') {
    await ws.update(TEMPLATE_GEN_SESSION_KEYS.awaitName, undefined);
    stream.markdown('_Cancelled — no template was saved._');
    return;
  }
  if (parsed.action === 'empty') {
    // KTD3: this ask's cancel check is isExplicitCancelToken() (literal "(c)"), not isCancellation()'s
  // broader word list — the link resubmits "(c)" itself so the click reproduces exactly what
  // already works, without touching that parser (Risks section).
  stream.markdown(trustedChatMarkdown(
    `What should the new template be named?\n\nReply with a name, or ${buildChatCommandLink('Cancel', '@jira', '(c)')}.`,
  ));
    return { metadata: { jiraSession: { kinds: [TEMPLATE_GEN_KINDS.awaitName] } } };
  }

  await ws.update(TEMPLATE_GEN_SESSION_KEYS.awaitName, undefined);
  const { projectKeyHint, sourceTicketKey, issueTypeHint } = session;
  return continueGenerateTemplate(
    parsed.value, { projectKeyHint, sourceTicketKey, issueTypeHint },
    ticketService, workspaceRoot, hiddenDisplayFields, stream, ws,
  );
}

async function startFromReferenceTicket(
  templateName: string,
  sourceTicketKey: string,
  ticketService: TicketService,
  hiddenDisplayFields: string[],
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
): Promise<vscode.ChatResult | void> {
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
  return streamReview(reviewSession, stream, ws);
}

async function startFromRequiredFields(
  templateName: string,
  projectKey: string,
  issueType: string,
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
  issueTypeId?: string,
): Promise<vscode.ChatResult | void> {
  let candidates: TemplateFieldCandidate[];
  try {
    candidates = await ticketService.getTemplateCandidatesFromRequiredFields(projectKey, issueType, issueTypeId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logDiag(SCOPE, 'error', `Could not fetch required fields — ${projectKey}/${issueType}`, { projectKey, issueType, error: message });
    stream.markdown(`_Could not fetch required fields for **${issueType}** in **${projectKey}**: ${message}_`);
    return;
  }

  // Checked on the unfiltered fetch result, not the per-ticket-filtered rows below: an issue type
  // whose only required fields are summary/description/etc. (the common, fully successful case —
  // Jira requires summary on virtually every type) would otherwise trip this warning on every
  // generation, even though the fetch succeeded and nothing is actually missing.
  if (candidates.length === 0) {
    // Legitimately empty: either the issue type genuinely has no required fields, or the caller
    // lacks Create-issue permission on it — the API gives no way to tell these apart (R4), so this
    // single warning covers both rather than guessing. Informational only: the (empty) review list
    // still renders below and is still confirmable/saveable, exactly as before this warning existed.
    logDiag(SCOPE, 'warn', `No required fields found — ${projectKey}/${issueType}`, { projectKey, issueType });
    stream.markdown(`${buildEmptyRequiredFieldsWarning(issueType, projectKey)}\n\n`);
  }

  const rows = buildTemplateFieldReviewRows(filterOutPerTicketFields(candidates));

  const reviewSession: TemplateGenerationReviewSession = {
    templateName, projectKey, issueType, sourceTicketKey: null, rows, schemaVersion: CURRENT_SESSION_SCHEMA_VERSION,
  };
  return streamReview(reviewSession, stream, ws);
}

// --- Issue-type pick list (no-reference path, no type named) ---

export async function streamTypePick(
  session: TemplateGenerationTypePickSession,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
): Promise<vscode.ChatResult> {
  await ws.update(TEMPLATE_GEN_SESSION_KEYS.typePick, session);
  const list = session.availableIssueTypes.map((t, i) => `${i + 1}. ${buildChatCommandLink(t.name, '@jira', String(i + 1))}`).join('\n');
  stream.markdown(trustedChatMarkdown(
    `Generating template **${session.templateName}** for project **${session.projectKey}** — which issue type?\n\n` +
    `${list}\n\nReply with a number, or ${buildChatCommandLink('Cancel', '@jira', 'cancel')}.`,
  ));
  return { metadata: { jiraSession: { kinds: [TEMPLATE_GEN_KINDS.typePick] } } };
}

export async function handleTypePickReply(
  reply: string,
  session: TemplateGenerationTypePickSession,
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
): Promise<vscode.ChatResult | void> {
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
    stream.markdown(trustedChatMarkdown(
      `Didn't understand that. Reply with a number, or ${buildChatCommandLink('Cancel', '@jira', 'cancel')}.`,
    ));
    return { metadata: { jiraSession: { kinds: [TEMPLATE_GEN_KINDS.typePick] } } };
  }

  await ws.update(TEMPLATE_GEN_SESSION_KEYS.typePick, undefined);
  return startFromRequiredFields(session.templateName, session.projectKey, pick.name, ticketService, stream, ws, pick.id);
}

// --- Free-text issue type chat-ask (R3: a chat reply-and-continue step when the type list can't
// be fetched, not a showInputBox) ---

export async function streamAwaitFreeType(
  session: TemplateGenerationAwaitFreeTypeSession,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
): Promise<vscode.ChatResult> {
  await ws.update(TEMPLATE_GEN_SESSION_KEYS.awaitFreeType, session);
  // KTD3: this ask's cancel check is isExplicitCancelToken() (literal "(c)"), not isCancellation()'s
  // broader word list — the link resubmits "(c)" itself so the click reproduces exactly what
  // already works, without touching that parser (Risks section).
  stream.markdown(trustedChatMarkdown(
    `Could not fetch **${session.projectKey}**'s issue types. What issue type should **${session.templateName}** use ` +
    `(e.g. Bug, Story, Task)?\n\nReply with a type, or ${buildChatCommandLink('Cancel', '@jira', '(c)')}.`,
  ));
  return { metadata: { jiraSession: { kinds: [TEMPLATE_GEN_KINDS.awaitFreeType] } } };
}

export async function handleAwaitFreeTypeReply(
  reply: string,
  session: TemplateGenerationAwaitFreeTypeSession,
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
): Promise<vscode.ChatResult | void> {
  if (isSessionExpired(session)) {
    await ws.update(TEMPLATE_GEN_SESSION_KEYS.awaitFreeType, undefined);
    stream.markdown(SESSION_EXPIRED_MESSAGE);
    return;
  }

  // KTD3: only an explicit "(c)" cancels here, not isCancellation()'s broader word list — see
  // parseAwaitFreeTextReply's doc comment in sessionState.ts.
  const parsed = parseAwaitFreeTextReply(reply);
  if (parsed.action === 'cancel') {
    await ws.update(TEMPLATE_GEN_SESSION_KEYS.awaitFreeType, undefined);
    stream.markdown('_Cancelled — no template was saved._');
    return;
  }
  if (parsed.action === 'empty') {
    stream.markdown(trustedChatMarkdown(
      `What issue type should **${session.templateName}** use (e.g. Bug, Story, Task)?\n\n` +
      `Reply with a type, or ${buildChatCommandLink('Cancel', '@jira', '(c)')}.`,
    ));
    return { metadata: { jiraSession: { kinds: [TEMPLATE_GEN_KINDS.awaitFreeType] } } };
  }

  await ws.update(TEMPLATE_GEN_SESSION_KEYS.awaitFreeType, undefined);
  return startFromRequiredFields(session.templateName, session.projectKey, parsed.value, ticketService, stream, ws);
}

// --- Review list (toggle / setValue / confirm) ---

export async function streamReview(
  session: TemplateGenerationReviewSession,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
): Promise<vscode.ChatResult> {
  await ws.update(TEMPLATE_GEN_SESSION_KEYS.review, session);
  const sourceLine = session.sourceTicketKey
    ? `_Generating from **${session.sourceTicketKey}**._`
    : `_Generating from **${session.projectKey}**'s required fields for **${session.issueType}**._`;
  stream.markdown(`${sourceLine}\n\n${buildTemplateFieldReviewTable(session.rows)}`);
  return { metadata: { jiraSession: { kinds: [TEMPLATE_GEN_KINDS.review] } } };
}

export async function handleTemplateGenReviewReply(
  reply: string,
  session: TemplateGenerationReviewSession,
  workspaceRoot: string,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
): Promise<vscode.ChatResult | void> {
  if (isSessionExpired(session)) {
    await ws.update(TEMPLATE_GEN_SESSION_KEYS.review, undefined);
    stream.markdown(SESSION_EXPIRED_MESSAGE);
    return;
  }

  const rowIds = session.rows.map(r => r.id);
  const decision = parseReviewInput(reply, rowIds);

  if (decision.action === 'invalid') {
    stream.markdown(trustedChatMarkdown(
      `Didn't understand that. Reply ${buildChatCommandLink('Post it', '@jira', 'post it')} to save, ` +
      `${buildChatCommandLink('Cancel', '@jira', 'cancel')} to cancel, row numbers to toggle ` +
      `(e.g. \`2 4\`), or \`<number>=<value>\` to set a value (e.g. \`3=High\`).`,
    ));
    return { metadata: { jiraSession: { kinds: [TEMPLATE_GEN_KINDS.review] } } };
  }
  if (decision.action === 'cancel') {
    await ws.update(TEMPLATE_GEN_SESSION_KEYS.review, undefined);
    stream.markdown('_Cancelled — no template was saved._');
    return;
  }
  if (decision.action === 'toggle') {
    session.rows = applyReviewToggle(session.rows, decision.ids);
    return streamReview(session, stream, ws);
  }
  if (decision.action === 'setValue') {
    session.rows = applyReviewSetValue(session.rows, decision.id, decision.value);
    return streamReview(session, stream, ws);
  }

  // decision.action === 'ok' — a required field with no value to copy is filled inline in this
  // same review step, so a confirm with an included-but-still-unset row re-prompts instead
  // of silently saving it blank or silently dropping it from the template.
  const unset = findUnsetIncludedRows(session.rows);
  if (unset.length > 0) {
    const names = unset.map(r => `**${r.name}** (reply \`${r.id}=<value>\`)`).join(', ');
    stream.markdown(
      `These included fields still need a value before saving: ${names}.\n\n` +
      `${buildTemplateFieldReviewTable(session.rows)}`,
    );
    return { metadata: { jiraSession: { kinds: [TEMPLATE_GEN_KINDS.review] } } };
  }

  await ws.update(TEMPLATE_GEN_SESSION_KEYS.review, undefined);
  const template = buildGeneratedTemplate(session.templateName, session.issueType, session.rows);
  return attemptSave(template, session.projectKey, workspaceRoot, stream, ws, false);
}

// --- Save + name-collision handling ---

async function attemptSave(
  template: JiraTemplate,
  projectKey: string,
  workspaceRoot: string,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
  overwrite: boolean,
): Promise<vscode.ChatResult | void> {
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
    return streamCollision(collisionSession, stream, ws);
  }

  logDiag(SCOPE, 'info', `Template saved — ${template.name}`, { templateName: template.name, issueType: template.issueType });
  const offerSession: TemplateGenerationOfferCreateSession = {
    template: result.template, projectKey, schemaVersion: CURRENT_SESSION_SCHEMA_VERSION,
  };
  return streamOfferCreate(offerSession, stream, ws);
}

export async function streamCollision(
  session: TemplateGenerationCollisionSession,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
): Promise<vscode.ChatResult> {
  await ws.update(TEMPLATE_GEN_SESSION_KEYS.collision, session);
  stream.markdown(trustedChatMarkdown(
    `A template named **${session.template.name}** already exists. Reply with a different name to save ` +
    `under, ${buildChatCommandLink('Yes', '@jira', 'yes')} to overwrite the existing one, or ${buildChatCommandLink('Cancel', '@jira', 'cancel')}.`,
  ));
  return { metadata: { jiraSession: { kinds: [TEMPLATE_GEN_KINDS.collision] } } };
}

export async function handleTemplateGenCollisionReply(
  reply: string,
  session: TemplateGenerationCollisionSession,
  workspaceRoot: string,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
): Promise<vscode.ChatResult | void> {
  if (isSessionExpired(session)) {
    await ws.update(TEMPLATE_GEN_SESSION_KEYS.collision, undefined);
    stream.markdown(SESSION_EXPIRED_MESSAGE);
    return;
  }

  const decision = parseTemplateCollisionReply(reply);
  if (decision.action === 'invalid') {
    stream.markdown(`Didn't understand that.\n\n`);
    return streamCollision(session, stream, ws);
  }
  if (decision.action === 'cancel') {
    await ws.update(TEMPLATE_GEN_SESSION_KEYS.collision, undefined);
    stream.markdown('_Cancelled — no template was saved._');
    return;
  }

  await ws.update(TEMPLATE_GEN_SESSION_KEYS.collision, undefined);
  if (decision.action === 'overwrite') {
    return attemptSave(session.template, session.projectKey, workspaceRoot, stream, ws, true);
  }
  // decision.action === 'rename'
  const renamed: JiraTemplate = { ...session.template, name: decision.name };
  return attemptSave(renamed, session.projectKey, workspaceRoot, stream, ws, false);
}

// --- Offer to create a first ticket ---

export async function streamOfferCreate(
  session: TemplateGenerationOfferCreateSession,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
): Promise<vscode.ChatResult> {
  await ws.update(TEMPLATE_GEN_SESSION_KEYS.offerCreate, session);
  stream.markdown(trustedChatMarkdown(
    `Template **${session.template.name}** saved.\n\nCreate a first ticket from it now? Reply with a ` +
    `summary to create one, or ${buildChatCommandLink('No', '@jira', 'no')} to skip.`,
  ));
  return { metadata: { jiraSession: { kinds: [TEMPLATE_GEN_KINDS.offerCreate] } } };
}

export async function handleOfferCreateReply(
  reply: string,
  session: TemplateGenerationOfferCreateSession,
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
  baseUrl?: string,
): Promise<vscode.ChatResult | void> {
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
    return streamAwaitSummary(summarySession, stream, ws);
  }

  // decision.action === 'create'
  await ws.update(TEMPLATE_GEN_SESSION_KEYS.offerCreate, undefined);
  await createFirstTicket(session.template, session.projectKey, decision.summary, ticketService, stream, baseUrl);
}

export async function streamAwaitSummary(
  session: TemplateGenerationAwaitSummarySession,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
): Promise<vscode.ChatResult> {
  await ws.update(TEMPLATE_GEN_SESSION_KEYS.awaitSummary, session);
  stream.markdown(`What should the summary be?`);
  return { metadata: { jiraSession: { kinds: [TEMPLATE_GEN_KINDS.awaitSummary] } } };
}

export async function handleAwaitSummaryReply(
  reply: string,
  session: TemplateGenerationAwaitSummarySession,
  ticketService: TicketService,
  stream: vscode.ChatResponseStream,
  ws: vscode.Memento,
  baseUrl?: string,
): Promise<vscode.ChatResult | void> {
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
    stream.markdown(`What should the summary be?`);
    return { metadata: { jiraSession: { kinds: [TEMPLATE_GEN_KINDS.awaitSummary] } } };
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
