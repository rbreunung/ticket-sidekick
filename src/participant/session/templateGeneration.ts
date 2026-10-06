// Template generation flow: field review rows/table, collision and offer-create replies, session shapes.
// Pure (vscode-free); re-exported through ../sessionState.ts.

import type { JiraIssueType } from '../../jira/IJiraClient';
import { sanitizeCellText } from '../../utils/reportImport';
import { coerceTypedFieldValue, type TemplateFieldCandidate } from '../../services/TicketService';
import type { JiraTemplate } from '../../templates/TemplateService';
import { ReviewTableColumn, buildChatCommandLink, isCancellation, isConfirmation, pickByNumberOrName, renderReviewTable } from './primitives';

// ---------------------------------------------------------------------------------------------
// Template generation — the multi-turn flow that turns a reference ticket's template-shaped
// fields, or (with no reference) a project's required-fields create-metadata, into a reviewed,
// saved `.jira-templates.json` template. Reuses the shared renderReviewTable/parseReviewInput
// primitives above plus the `<row-id>=<value>` reply form for filling in a
// no-reference row's still-empty value inline, without a separate multi-turn detour. All
// `vscode`-coupled orchestration (streaming, workspaceState, calling TicketService/TemplateService)
// lives in `templateGenerationHandler.ts`; only pure session shapes/helpers live here so they stay
// Vitest-loadable.
// ---------------------------------------------------------------------------------------------

// Jira's required-fields create-metadata (the no-reference path's source, TicketService's
// getTemplateCandidatesFromRequiredFields) is not filtered by TicketService's template-shaped-field
// allowlist the way the reference-ticket path is — it returns every field the issue type's create screen
// requires, which routinely includes fields that are never template data: summary/description are
// per-ticket content, and project/issuetype/reporter are already resolved elsewhere in this flow.
// Filtered out here (not in TicketService) since it's specific to how this handler presents the
// no-reference candidate list, not a general rule TicketService's other callers need.
const PER_TICKET_FIELD_IDS = new Set(['summary', 'description', 'issuetype', 'project', 'reporter']);

export function filterOutPerTicketFields(candidates: TemplateFieldCandidate[]): TemplateFieldCandidate[] {
  return candidates.filter(c => !PER_TICKET_FIELD_IDS.has(c.id));
}

/** One row of the template-generation review list. `id` is a short display index ('1'..'N'),
 * matching the existing review-row convention (Veracode/Waltz's `id` is likewise a display index,
 * not the underlying identity) — `fieldId` carries the real Jira field id that gets written into
 * `defaultFields`. `value` is `undefined` when there's nothing to show yet (a no-reference row
 * before the user fills it in via `<id>=<value>`). */
export interface TemplateFieldReviewRow {
  id: string;
  fieldId: string;
  name: string;
  value: unknown;
  included: boolean;
  schema?: TemplateFieldCandidate['schema'];
}

export function buildTemplateFieldReviewRows(candidates: TemplateFieldCandidate[]): TemplateFieldReviewRow[] {
  return candidates.map((c, i) => ({
    id: String(i + 1),
    fieldId: c.id,
    name: c.name,
    value: c.value,
    included: true,
    schema: c.schema,
  }));
}

// Renders a candidate value for the review table. Objects/arrays are unwrapped to their most
// display-relevant piece (a `name`, an `id`, or a joined list) rather than shown as raw JSON —
// mirrors the shapes README's template examples document (`{ name: "High" }`, `[{ name: "Backend" }]`).
export function formatTemplateFieldValue(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(formatTemplateFieldValue).join(', ');
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (typeof obj.name === 'string') return obj.name;
    if (obj.id !== undefined) return String(obj.id);
    return JSON.stringify(obj);
  }
  return String(value);
}

export const TEMPLATE_FIELD_REVIEW_COLUMNS: ReviewTableColumn<TemplateFieldReviewRow>[] = [
  { header: '#', accessor: (r) => r.id },
  { header: 'Field', accessor: (r) => sanitizeCellText(r.name) },
  {
    header: 'Value',
    accessor: (r) => r.value === undefined
      ? `_not set — reply \`${r.id}=<value>\`_`
      : sanitizeCellText(formatTemplateFieldValue(r.value)),
  },
  // R12(d): the Include? cell is itself the toggle — clicking it resubmits the row's own id, which
  // applyReviewToggle already flips (same text a typed "2 4" list uses), so no new parser logic.
  { header: 'Include?', accessor: (r) => buildChatCommandLink(r.included ? '✓' : '_excluded_', '@jira', r.id) },
];

// R12(c/d): the output embeds live command links (the Include? toggle cells and the Post it /
// Cancel footer), so callers MUST stream it through `trustedChatMarkdown(...)` — a plain
// `stream.markdown(string)` would render those links inert. This function stays vscode-free
// (KTD5) and therefore cannot wrap itself; the trust-gate is a caller obligation.
export function buildTemplateFieldReviewTable(rows: TemplateFieldReviewRow[]): string {
  return renderReviewTable(TEMPLATE_FIELD_REVIEW_COLUMNS, rows) +
    // R12(c): the cancel link resubmits the word `cancel`, not `(c)` — this table is parsed by
    // parseReviewInput → isCancellation(), which contains `cancel` but not the literal `(c)`. A
    // `(c)` link would parse as `invalid` and re-prompt instead of cancelling.
    `\n\nReply ${buildChatCommandLink('Post it', '@jira', 'post it')} to save, ` +
    `${buildChatCommandLink('Cancel', '@jira', 'cancel')} to cancel, row numbers to toggle in/out (e.g. \`2 4\`), ` +
    'or `<number>=<value>` to set a value (e.g. `3=High`).';
}

/** Warning line for the required-fields review screen when the fetch legitimately returns zero
 * candidates (R4). The Jira API gives no way to distinguish "this issue type genuinely has no
 * required fields" from "the caller lacks Create-issue permission on it" — both produce the same
 * empty response — so the wording covers both rather than guessing which applies. Purely
 * informational: the caller still renders the (empty) review list and still allows saving it. */
export function buildEmptyRequiredFieldsWarning(issueType: string, projectKey: string): string {
  return `_No required fields found for **${issueType}** in **${projectKey}** — this may mean the ` +
    `type has none, or that you lack Create permission for it._`;
}

/** Rows still included but with no value filled in. A confirm ("post it") must not silently save
 * a required field as blank, and must not silently drop it from the template either — the caller
 * re-prompts for these instead of proceeding to save. */
export function findUnsetIncludedRows(rows: TemplateFieldReviewRow[]): TemplateFieldReviewRow[] {
  return rows.filter(r => r.included && r.value === undefined);
}

/** Builds the literal `defaultFields` map (never `resolveFields`) from the reviewed rows.
 * Only included rows with a resolved value contribute; call findUnsetIncludedRows() first so an
 * included-but-still-unset row never reaches here silently. */
export function buildDefaultFieldsFromRows(rows: TemplateFieldReviewRow[]): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const row of rows) {
    if (!row.included || row.value === undefined) continue;
    // A value copied from a reference ticket already has its real Jira shape (object/array).
    // Only a hand-typed `<id>=<value>` reply is ever a bare string here, and that needs
    // coercing into a writable shape before it becomes a defaultFields entry — a raw string
    // where Jira expects e.g. `{ name }` (priority) or `string[]` (labels) gets rejected.
    fields[row.fieldId] = typeof row.value === 'string'
      ? coerceTypedFieldValue(row.value, row.schema)
      : row.value;
  }
  return fields;
}

export function buildGeneratedTemplate(templateName: string, issueType: string, rows: TemplateFieldReviewRow[]): JiraTemplate {
  return {
    name: templateName,
    issueType,
    defaultFields: buildDefaultFieldsFromRows(rows),
  };
}

/** Derives a project key from a reference ticket key (e.g. `PROJ-123` -> `PROJ`) — used on the
 * reference-ticket generation path so the user isn't asked for a project key the ticket key
 * already implies. Returns null for anything that doesn't look like a real ticket key. */
export function extractProjectKeyFromTicketKey(ticketKey: string): string | null {
  const match = ticketKey.trim().match(/^([A-Z][A-Z0-9]+)-\d+$/);
  return match ? match[1] : null;
}

/** Parses a reply to the "pick an issue type" list (no-reference path, no type named) — by
 * number or by exact (case-insensitive) name. Returns the matched `{id, name}` entry itself (not
 * just its name) so the caller can forward the real issue type id to getRequiredFields(). */
export function parseIssueTypePick<T extends { name: string }>(
  reply: string,
  issueTypes: T[],
): T | 'cancel' | 'invalid' {
  // Offered issue types win over cancel words, so a type named "Stop" stays pickable.
  const picked = pickByNumberOrName(reply, issueTypes, (t) => t.name);
  if (picked) return picked;
  return isCancellation(reply) ? 'cancel' : 'invalid';
}

export type TemplateCollisionReply =
  | { action: 'cancel' }
  | { action: 'overwrite' }
  | { action: 'rename'; name: string }
  | { action: 'invalid' };

/** Parses the name-collision reply: cancel the whole flow, explicitly confirm overwriting the
 * existing template, or give a different name to retry the save under (the reviewed field set is
 * preserved by the caller across this reply — see TemplateGenerationCollisionSession). */
export function parseTemplateCollisionReply(reply: string): TemplateCollisionReply {
  if (isCancellation(reply)) return { action: 'cancel' };
  if (isConfirmation(reply)) return { action: 'overwrite' };
  const name = reply.trim();
  if (name.length === 0) return { action: 'invalid' };
  return { action: 'rename', name };
}

export type OfferCreateReply =
  | { action: 'decline' }
  | { action: 'needSummary' }
  | { action: 'create'; summary: string };

/** Parses the "create a first ticket?" reply. A bare confirmation word ("yes") has no summary
 * in it yet, so it's distinguished from a reply that supplies the summary directly in one turn —
 * both are accepted so the flow doesn't force an extra round-trip when the user just answers with
 * the summary up front. */
export function parseOfferCreateReply(reply: string): OfferCreateReply {
  if (isCancellation(reply)) return { action: 'decline' };
  if (isConfirmation(reply)) return { action: 'needSummary' };
  const trimmed = reply.trim();
  if (trimmed.length === 0) return { action: 'decline' };
  return { action: 'create', summary: trimmed };
}

// --- Session shapes, workspaceState-persisted across turns. Keys/tags live in
// templateGenerationHandler.ts (the vscode-coupled layer that reads/writes workspaceState). ---

/** R2: chat-ask for the template name when handleGenerateTemplate's request didn't supply one
 * (replaces a showInputBox — see KTD2). Carries TemplateGenerationRequest's other three fields,
 * already known at prompt time, so the resuming turn can hand them straight to
 * continueGenerateTemplate() once the name arrives, without re-deriving them from the original
 * chat message. Everything else that continuation needs (workspaceRoot, hiddenDisplayFields,
 * ticketService) is re-derived fresh on the resuming turn from the live call in
 * JiraParticipant.ts, the same way every other resume in this flow already works. */
export interface TemplateGenerationAwaitNameSession {
  projectKeyHint: string | null;
  sourceTicketKey: string | null;
  issueTypeHint: string | null;
  schemaVersion: number;
}

export interface TemplateGenerationTypePickSession {
  templateName: string;
  projectKey: string;
  availableIssueTypes: Array<Pick<JiraIssueType, 'id' | 'name'>>;
  schemaVersion: number;
}

/** R3: chat-ask for a free-text issue type when the project's issue-type list couldn't be fetched
 * and no issue type is otherwise known (replaces a showInputBox — see KTD2). templateName and
 * projectKey are already resolved by this point in the flow, so both travel with the session
 * rather than being re-asked. */
export interface TemplateGenerationAwaitFreeTypeSession {
  templateName: string;
  projectKey: string;
  schemaVersion: number;
}

export interface TemplateGenerationReviewSession {
  templateName: string;
  projectKey: string;
  issueType: string;
  sourceTicketKey: string | null;
  rows: TemplateFieldReviewRow[];
  schemaVersion: number;
}

/** Shared shape for the three later template-generation stages, which all carry only a template
 * plus project key — the stage (collision pending resolution, just-saved awaiting the
 * create-first-ticket offer, or awaiting a typed-in summary) is distinguished by which
 * workspaceState key/response tag holds the session, not by its shape. `template.name` on a
 * collision session is the attempted/colliding name; on the other two it's the already-saved name. */
export interface TemplateGenerationTemplateStageSession {
  template: JiraTemplate;
  projectKey: string;
  schemaVersion: number;
}

export type TemplateGenerationCollisionSession = TemplateGenerationTemplateStageSession;

export type TemplateGenerationOfferCreateSession = TemplateGenerationTemplateStageSession;

export type TemplateGenerationAwaitSummarySession = TemplateGenerationTemplateStageSession;
