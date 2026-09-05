import type { IJiraClient, JiraAttachment, JiraComment, JiraEditMetaField, JiraFieldMeta, JiraFilter, JiraIssue, JiraIssueLink, JiraIssueType, JiraRemoteLink, JiraSearchResult, JiraSprintCandidate } from '../jira/IJiraClient';
import type { DiagLogger } from '../utils/diagTypes';
import { formatJiraBody } from '../utils/markdownFormatter';
import { formatFileSize } from '../utils/attachmentEligibility';
import { renderReviewTable, neutralizeMarkdownLinks, type ReviewTableColumn } from '../participant/sessionState';

export type FieldResolutionResult =
  | { kind: 'match'; field: JiraFieldMeta }
  | { kind: 'candidates'; fields: JiraFieldMeta[] }
  | { kind: 'none' };

/** Result of `TicketService.createTicket` — exposes the created key directly so callers that
 * need it (batch progress lines, the last-ticket marker) don't have to parse it back out of `message`. */
export interface CreatedTicket {
  key: string;
  message: string;
}

/** Thrown by `transitionAlongPath` when a multi-hop transition fails partway through. Each hop
 * is a real Jira write, so a failure after hop 1 leaves the ticket at an intermediate status —
 * not its original one — and the caller needs `completedHops`/`totalHops` to say so accurately,
 * rather than reporting a bare "transition failed" that implies nothing changed. */
export class PartialTransitionError extends Error {
  constructor(
    public readonly issueKey: string,
    public readonly completedHops: number,
    public readonly totalHops: number,
    public readonly failedTargetStatus: string,
    public readonly cause: unknown,
  ) {
    const causeMessage = cause instanceof Error ? cause.message : String(cause);
    const progress = completedHops > 0
      ? `${completedHops} of ${totalHops} hop(s) completed before failing`
      : 'failed on the first hop';
    super(`${issueKey}: transition to "${failedTargetStatus}" failed (${progress}): ${causeMessage}`);
    this.name = 'PartialTransitionError';
  }
}

/** One field proposed for a generated template's review list. `value` is a literal snapshot
 * taken from a reference ticket; it's absent for a no-reference candidate pulled from
 * required-fields create-metadata, where the review step fills the value in later. */
export interface TemplateFieldCandidate {
  id: string;
  name: string;
  value?: unknown;
  /** The field's Jira schema, when known — lets a hand-typed replacement value (from the
   * template-generation review list) be coerced into a Jira-writable shape instead of saved as a
   * bare string. Absent only when the candidate came from a source with no schema to offer. */
  schema?: JiraFieldMeta['schema'];
}

/**
 * Coerces a hand-typed review-list value (always a plain string) into the shape Jira's
 * create-issue API expects for the given field schema, so a value typed for a required field
 * with nothing to copy (no reference ticket) is writable rather than saved as a raw string that
 * Jira would reject. Array-of-string schemas (labels) become a one-element array; array-of-object
 * schemas (components, versions, custom multiselects) become a one-element array of `{ name }`;
 * other named-object schemas (priority, status, …) become `{ name }`; plain string/number schemas
 * pass through unchanged. A value copied from a reference ticket already has its real shape and
 * is never passed through this — only a fresh hand-typed string needs coercing.
 */
export function coerceTypedFieldValue(rawInput: string, schema?: JiraFieldMeta['schema']): unknown {
  if (!schema) return rawInput;
  if (schema.type === 'array') {
    const parts = rawInput.split(',').map(s => s.trim()).filter(Boolean);
    return schema.items === 'string' ? parts : parts.map(name => ({ name }));
  }
  if (schema.type === 'string' || schema.type === 'number') return rawInput;
  return { name: rawInput };
}

export function resolveFieldIdFuzzy(input: string, fields: JiraFieldMeta[]): FieldResolutionResult {
  const lower = input.toLowerCase();
  // 1. Exact case-insensitive match
  const exact = fields.find(f => f.name.toLowerCase() === lower);
  if (exact) return { kind: 'match', field: exact };
  // Also exact match on ID
  const exactId = fields.find(f => f.id.toLowerCase() === lower);
  if (exactId) return { kind: 'match', field: exactId };
  // 2. Prefix match — unique
  const prefix = fields.filter(f => f.name.toLowerCase().startsWith(lower));
  if (prefix.length === 1) return { kind: 'match', field: prefix[0] };
  if (prefix.length > 1) return { kind: 'candidates', fields: prefix };
  // 3. Substring match — unique
  const sub = fields.filter(f => f.name.toLowerCase().includes(lower));
  if (sub.length === 1) return { kind: 'match', field: sub[0] };
  if (sub.length > 1) return { kind: 'candidates', fields: sub };
  return { kind: 'none' };
}

const EXCLUDED_FROM_TABLE = new Set(['summary', 'comment', 'subtasks', 'issuelinks']);

// Jira DC (older) returns sprint values as serialized Java strings rather than JSON objects.
// Both shapes are normalised to { name, state } here.
function parseSprintItem(item: unknown): { name: string; state: string } | null {
  if (typeof item === 'string') {
    const name = item.match(/\bname=([^,\]]+)/)?.[1]?.trim();
    const state = item.match(/\bstate=([^,\]]+)/)?.[1]?.toLowerCase();
    return name ? { name, state: state ?? '' } : null;
  }
  if (typeof item === 'object' && item !== null && 'name' in item) {
    return item as { name: string; state: string };
  }
  return null;
}

// A ticket can have multiple sprints (past + current); the active one is the one worth showing
// or snapshotting, falling back to the first when none is active. Shared by every sprint-value
// call site in this file (display and template-candidate extraction alike).
function pickActiveOrFirst<T extends { state: string }>(items: T[]): T | undefined {
  return items.find(s => s.state === 'active') ?? items[0];
}

// Sibling to parseSprintItem: extracts a sprint item's numeric id (for a writable { id }
// literal) instead of its display name. Same dual-shape handling — Jira DC's serialized-Java
// string vs Cloud's plain object — but a different field of interest, so kept separate rather
// than overloading parseSprintItem's { name, state } shape.
function parseSprintId(item: unknown): number | null {
  if (typeof item === 'string') {
    const idStr = item.match(/\bid=([^,\]]+)/)?.[1]?.trim();
    if (idStr === undefined) return null;
    const id = Number(idStr);
    return Number.isFinite(id) ? id : null;
  }
  if (typeof item === 'object' && item !== null && 'id' in item) {
    const id = Number((item as { id: unknown }).id);
    return Number.isFinite(id) ? id : null;
  }
  return null;
}

// Picks the writable { id } for a sprint field's raw fetched value — an exception to taking the
// raw value as a literal snapshot, since a sprint's raw value is never itself a writable literal.
// Mirrors renderFieldValue's active-else-first sprint selection so the template snapshot matches
// what the user sees displayed. Returns null if no id can be parsed, so the caller can drop the
// field rather than write garbage.
function extractSprintIdCandidate(value: unknown): number | null {
  if (!Array.isArray(value)) return null;
  const items = value
    .map(item => {
      const display = parseSprintItem(item);
      const id = parseSprintId(item);
      return display && id !== null ? { id, state: display.state } : null;
    })
    .filter((v): v is { id: number; state: string } => v !== null);
  const active = pickActiveOrFirst(items);
  return active ? active.id : null;
}

// Template-shaped fields are a fixed, named allowlist — priority, labels, components, and
// sprint/team-typed custom fields (recognized via schema.custom the same way renderFieldValue's
// gh-sprint check does) — never inferred from schema metadata alone. Mirrors isMultiLine's
// fixed-list precedent for a different field-shape decision.
export function isTemplateShapedField(meta: JiraFieldMeta): boolean {
  if (meta.id === 'priority' || meta.id === 'labels' || meta.id === 'components') return true;
  const custom = meta.schema.custom ?? '';
  if (custom.includes('gh-sprint')) return true;
  if (custom.includes('rm-teams')) return true;
  return false;
}

export function renderFieldValue(value: unknown, meta: JiraFieldMeta): string {
  if (value === null || value === undefined) return '_Not set_';

  // Sprint (gh-sprint in custom)
  if (meta.schema.custom?.includes('gh-sprint') && Array.isArray(value)) {
    const sprints = value.map(parseSprintItem).filter(Boolean) as Array<{ name: string; state: string }>;
    const active = pickActiveOrFirst(sprints);
    return active ? active.name : '_None_';
  }

  // User
  if (meta.schema.type === 'user') {
    const u = value as { displayName?: string } | null;
    return u?.displayName ?? '_Unassigned_';
  }

  // Datetime
  if (meta.schema.type === 'datetime' && typeof value === 'string') {
    const d = new Date(value);
    if (!isNaN(d.getTime())) {
      const pad = (n: number) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }
    return value;
  }

  // Date
  if (meta.schema.type === 'date' && typeof value === 'string') return value.slice(0, 10);

  // Named objects (status, priority, issuetype, version, …)
  if (typeof value === 'object' && value !== null && !Array.isArray(value) && 'name' in value) {
    return (value as { name: string }).name;
  }

  // Arrays
  if (Array.isArray(value)) {
    if (value.length === 0) return '_None_';
    const items = value.map(item => {
      if (typeof item === 'string') return item;
      if (typeof item === 'object' && item !== null) {
        if ('name' in item) return (item as { name: string }).name;
        if ('value' in item) return (item as { value: string }).value;
        if ('displayName' in item) return (item as { displayName: string }).displayName;
      }
      return String(item);
    });
    return items.length > 3
      ? `${items.slice(0, 3).join(', ')} … (+${items.length - 3} more)`
      : items.join(', ');
  }

  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return value;
  return String(value);
}

/**
 * Builds one `ReviewTableColumn` per configured field ID, shared by search's own extra columns
 * (#3), the cleanup/transition review table, and any future review table that wants opt-in extra
 * field columns (KTD1). `valueOf` lets each caller read a field's raw value off its own row shape;
 * `onUnknownField`, when given, fires once per unrecognized field ID for this call — not once per
 * row — so callers can log a single warning per render (KTD5) rather than spamming one per row.
 * Every rendered value is pipe-escaped so it can't break the surrounding markdown table.
 */
export function buildExtraFieldColumns<TRow>(
  fieldIds: string[],
  fieldMeta: JiraFieldMeta[],
  valueOf: (row: TRow, fieldId: string) => unknown,
  onUnknownField?: (fieldId: string) => void,
): ReviewTableColumn<TRow>[] {
  const metaById = new Map(fieldMeta.map((m) => [m.id, m]));
  return fieldIds.map((id) => {
    const meta = metaById.get(id);
    if (!meta) onUnknownField?.(id);
    return {
      header: meta?.name ?? id,
      accessor: (row: TRow) => {
        const rendered = meta ? renderFieldValue(valueOf(row, id), meta) : '_Not set_';
        // Custom field values are untrusted, externally-influenced content — see
        // neutralizeMarkdownLinks()'s own doc comment (sessionState.ts) for why this table's
        // trust-gated footer (KTD5) requires it here.
        return neutralizeMarkdownLinks(rendered.replace(/\|/g, '\\|'));
      },
    };
  });
}

export function isMultiLine(value: unknown, meta: JiraFieldMeta): boolean {
  // Rich-content object (ADF) always gets its own section.
  if (typeof value === 'object' && value !== null && !Array.isArray(value) && 'type' in value) return true;
  if (typeof value !== 'string') return false;

  // Prefer the field schema over the value length: a textarea / description / environment
  // field is multi-line even when short, and a single-line text or URL field stays inline
  // even when long (e.g. a long URL shouldn't be torn out of the table).
  const custom = meta.schema.custom ?? '';
  if (custom.includes('textarea')) return true;
  if (meta.id === 'description' || meta.id === 'environment') return true;
  if (custom.includes('textfield') || custom.includes('url')) return false;

  // Fallback heuristic for fields without a known schema hint.
  return value.length > 120;
}

/** Renders a ticket key as a clickable Jira link when `baseUrl` is configured, else the bare key. */
export function formatKeyLink(key: string, baseUrl?: string): string {
  return baseUrl ? `[${key}](${baseUrl}/browse/${key})` : key;
}

export function formatIssueLinkLine(link: JiraIssueLink, baseUrl?: string): string {
  const linked = link.outwardIssue ?? link.inwardIssue;
  if (!linked) return '';
  const label = link.outwardIssue ? link.type.outward : link.type.inward;
  const keyText = formatKeyLink(linked.key, baseUrl);
  return `- ${label} ${keyText}: ${linked.fields.summary} — ${linked.fields.status.name}`;
}

export function formatIssueFields(
  issue: JiraIssue,
  fieldMeta: JiraFieldMeta[],
  alwaysShowIds: Set<string>,
  hiddenIds?: Set<string>,
  baseUrl?: string,
): { table: string; sections: string[] } {
  const navigable = new Map(fieldMeta.filter(f => f.navigable === true).map(f => [f.id, f]));
  const tableRows: string[] = [];
  const sections: string[] = [];

  if (issue.fields.issuelinks && issue.fields.issuelinks.length > 0) {
    const lines = issue.fields.issuelinks
      .map(l => formatIssueLinkLine(l, baseUrl))
      .filter(Boolean);
    if (lines.length > 0) sections.push(`## Linked Issues\n\n${lines.join('\n')}`);
  }
  const processedIds = new Set<string>();

  for (const [fieldId, value] of Object.entries(issue.fields)) {
    if (EXCLUDED_FROM_TABLE.has(fieldId)) continue;
    const meta = navigable.get(fieldId);
    if (!meta) continue;
    if (hiddenIds?.has(fieldId) && !alwaysShowIds.has(fieldId)) continue;
    processedIds.add(fieldId);

    const isNull = value === null || value === undefined ||
      (Array.isArray(value) && value.length === 0);
    if (isNull && !alwaysShowIds.has(fieldId)) continue;
    if (isNull) { tableRows.push(`| **${meta.name}** | _Not set_ |`); continue; }

    if (meta.id === 'attachment' && Array.isArray(value)) {
      const lines = (value as JiraAttachment[]).map(a => `- [${a.filename}](${a.content}) — ${formatFileSize(a.size)} (${a.mimeType})`);
      sections.push(`## Attachments\n\n${lines.join('\n')}`);
      continue;
    }

    if (isMultiLine(value, meta)) {
      const content = formatJiraBody(value).trim() || '_No content_';
      sections.push(`## ${meta.name}\n\n${content}`);
    } else {
      tableRows.push(`| **${meta.name}** | ${renderFieldValue(value, meta)} |`);
    }
  }

  // Always-show fields not present in the issue
  for (const fieldId of alwaysShowIds) {
    if (processedIds.has(fieldId)) continue;
    const meta = navigable.get(fieldId);
    if (!meta) continue;
    tableRows.push(`| **${meta.name}** | _Not set_ |`);
  }

  const table = tableRows.length > 0
    ? `| Field | Value |\n| --- | --- |\n${tableRows.join('\n')}`
    : '';
  return { table, sections };
}

const SUPPORTED_FIELDS: Record<string, string> = {
  summary: 'summary',
  description: 'description',
  priority: 'priority',
  assignee: 'assignee',
  labels: 'labels',
  components: 'components',
  component: 'components',
  'fix version': 'fixVersions',
  fixversions: 'fixVersions',
  fixversion: 'fixVersions',
};

export function extractTextFromAdf(node: unknown): string {
  if (typeof node === 'string') return node; // API v2 returns plain text, not ADF
  if (!node || typeof node !== 'object') return '';
  const n = node as { text?: string; content?: unknown[] };
  if (typeof n.text === 'string') return n.text;
  if (Array.isArray(n.content)) return n.content.map(extractTextFromAdf).join(' ');
  return '';
}


export function assembleDescription(sections: string[], answers: Record<string, string>): string {
  return sections
    .filter((s) => s in answers)
    .map((s) => `**${s}**\n${answers[s]}`)
    .join('\n\n');
}

export class TicketService {
  constructor(private readonly client: IJiraClient, private readonly onDiag?: DiagLogger) {}

  async getFieldMeta(): Promise<JiraFieldMeta[]> {
    return this.client.getFields();
  }

  async getRemoteLinks(issueKey: string): Promise<JiraRemoteLink[]> {
    return this.client.getRemoteLinks(issueKey);
  }

  async getTicket(
    issueKey: string,
    fieldMeta?: JiraFieldMeta[],
    alwaysShowIds?: Set<string>,
    hiddenIds?: Set<string>,
    baseUrl?: string,
  ): Promise<string> {
    const issue = await this.client.getIssue(issueKey);
    const meta = fieldMeta ?? await this.client.getFields();
    const showIds = alwaysShowIds ?? new Set<string>();
    const { table, sections } = formatIssueFields(issue, meta, showIds, hiddenIds, baseUrl);
    const remoteLinks = await this.client.getRemoteLinks(issueKey);
    if (remoteLinks.length > 0) {
      const lines = remoteLinks.map(r => `- [${r.object.title}](${r.object.url})`);
      sections.push(`## Web Links\n\n${lines.join('\n')}`);
    }
    const heading = `## ${formatKeyLink(issue.key, baseUrl)}: ${issue.fields.summary}`;
    const parts: string[] = [heading];
    if (table) parts.push('', table);
    if (sections.length > 0) parts.push('', ...sections.map(s => s));
    return parts.join('\n');
  }

  async addComment(issueKey: string, body: string, baseUrl?: string): Promise<string> {
    await this.client.addComment(issueKey, body);
    this.onDiag?.('info', `Comment added — ${issueKey}`, { issueKey });
    return `comment added to ${formatKeyLink(issueKey, baseUrl)}.`;
  }

  async uploadAttachment(issueKey: string, filename: string, contentType: string, contentBytes: string): Promise<void> {
    return this.client.uploadAttachment(issueKey, filename, contentType, contentBytes);
  }

  async updateField(issueKey: string, fieldName: string, value: string, baseUrl?: string): Promise<string> {
    const jiraField = SUPPORTED_FIELDS[fieldName.toLowerCase()];
    if (!jiraField) {
      const supported = Object.keys(SUPPORTED_FIELDS)
        .filter((k) => !k.includes('fix') && k !== 'component' && k !== 'fixversions')
        .concat(['fix version'])
        .join(', ');
      return `Field "${fieldName}" is not supported. Supported fields: ${supported}.`;
    }

    let fieldValue: unknown;
    if (jiraField === 'priority') {
      fieldValue = { name: value };
    } else if (jiraField === 'assignee') {
      const resolved = await this.resolveAssignee(value);
      if (typeof resolved === 'string') return resolved;
      fieldValue = resolved;
    } else if (jiraField === 'description') {
      fieldValue = value;
    } else if (jiraField === 'labels') {
      fieldValue = value.split(',').map((l) => l.trim());
    } else if (jiraField === 'components') {
      fieldValue = value.split(',').map((c) => ({ name: c.trim() }));
    } else if (jiraField === 'fixVersions') {
      fieldValue = [{ name: value }];
    } else {
      fieldValue = value;
    }

    await this.client.updateIssue(issueKey, { [jiraField]: fieldValue });
    this.onDiag?.('info', `Field updated — ${issueKey} (${fieldName})`, { issueKey, fieldName });
    return `Updated ${fieldName} on ${formatKeyLink(issueKey, baseUrl)}.`;
  }

  async resolveAssignee(value: string): Promise<Record<string, string> | string> {
    const ME_KEYWORDS = new Set(['me', 'myself', 'i']);
    if (ME_KEYWORDS.has(value.toLowerCase().trim())) {
      const user = await this.client.getCurrentUser();
      if (user.name) return { name: user.name };
      if (user.accountId) return { accountId: user.accountId };
      return `Could not resolve user "${value}" — no accountId or name returned by Jira.`;
    }
    const users = await this.client.findUser(value);
    if (users.length === 0) return `No user found matching "${value}".`;
    if (users.length > 1) {
      return `Multiple users found: ${users.map((u) => u.displayName).join(', ')}. Please be more specific.`;
    }
    const user = users[0];
    if (user.name) return { name: user.name };
    if (user.accountId) return { accountId: user.accountId };
    return `Could not resolve user "${value}" — no accountId or name returned by Jira.`;
  }

  async searchTickets(
    jql: string,
    baseUrl?: string,
    extraFields: string[] = [],
    fieldMeta: JiraFieldMeta[] = [],
  ): Promise<string> {
    const result = await this.client.searchJql(jql, undefined, undefined, extraFields);
    if (result.issues.length === 0) return 'No tickets found.';

    const columns: ReviewTableColumn<JiraIssue>[] = [
      { header: 'Key', accessor: (issue) => formatKeyLink(issue.key, baseUrl) },
      { header: 'Summary', accessor: (issue) => issue.fields.summary },
      { header: 'Status', accessor: (issue) => issue.fields.status.name },
      { header: 'Assignee', accessor: (issue) => issue.fields.assignee ? issue.fields.assignee.displayName : 'Unassigned' },
      ...buildExtraFieldColumns<JiraIssue>(
        extraFields,
        fieldMeta,
        (issue, id) => (issue.fields as Record<string, unknown>)[id],
        (id) => this.onDiag?.('warn', `Unrecognized field in searchFields: ${id}`, { fieldId: id }),
      ),
    ];

    return [
      `Found ${result.total ?? result.issues.length} ticket(s):`,
      '',
      ...(baseUrl ? [`[View in Jira](${baseUrl}/issues/?jql=${encodeURIComponent(jql)})`, ''] : []),
      renderReviewTable(columns, result.issues),
    ].join('\n');
  }

  async validateRequiredFields(issueKey: string, requiredFields: string[]): Promise<string> {
    if (requiredFields.length === 0) {
      return 'No required fields configured. Add field names to `ticketSidekick.jira.requiredFields` in settings.';
    }
    const issue = await this.client.getIssue(issueKey);
    const missing = requiredFields.filter((field) => {
      const value = issue.fields[field];
      return (
        value === null ||
        value === undefined ||
        value === '' ||
        (Array.isArray(value) && value.length === 0)
      );
    });
    if (missing.length === 0) return `All required fields are set on ${issueKey}.`;
    return `${issueKey} is missing required fields: ${missing.join(', ')}.`;
  }

  async getIssueTypes(projectKey: string): Promise<JiraIssueType[]> {
    const project = await this.client.getProject(projectKey);
    return project.issueTypes.filter((t) => !t.subtask);
  }

  async getIssue(issueKey: string): Promise<JiraIssue> {
    return this.client.getIssue(issueKey);
  }

  getAttachments(issue: JiraIssue): JiraAttachment[] {
    return issue.fields.attachment ?? [];
  }

  async downloadAttachment(content: string): Promise<Uint8Array> {
    return this.client.downloadAttachment(content);
  }

  async getAllComments(issueKey: string): Promise<JiraComment[]> {
    return this.client.getAllComments(issueKey);
  }

  async getIssueComments(issueKey: string, maxResults = 20): Promise<{ comments: JiraComment[]; total: number }> {
    return this.client.getIssueComments(issueKey, maxResults);
  }

  async getOpenSubtasks(issueKey: string): Promise<Array<{ key: string; summary: string; currentStatus: string }>> {
    const issue = await this.client.getIssue(issueKey);
    return (issue.fields.subtasks ?? [])
      .filter((s) => s.fields.status.name !== 'Done')
      .map((s) => ({ key: s.key, summary: s.fields.summary, currentStatus: s.fields.status.name }));
  }

  async transitionAlongPath(
    issueKey: string,
    path: Array<{ id: string; name: string; to: string }>,
    resolution?: string,
  ): Promise<void> {
    for (let i = 0; i < path.length; i++) {
      const step = path[i];
      const fields: Record<string, unknown> = {};
      if (resolution && step.to === path.at(-1)!.to) fields.resolution = { name: resolution };
      const hasFields = Object.keys(fields).length > 0;
      try {
        await this.client.executeTransition(issueKey, step.id, hasFields ? fields : undefined);
      } catch (err) {
        if (hasFields && err instanceof Error && err.message.includes('"resolution"')) {
          try {
            await this.client.executeTransition(issueKey, step.id, undefined);
          } catch (retryErr) {
            throw new PartialTransitionError(issueKey, i, path.length, step.to, retryErr);
          }
        } else {
          throw new PartialTransitionError(issueKey, i, path.length, step.to, err);
        }
      }
    }
  }

  async searchTicketsRaw(jql: string, maxResults = 50, extraFields: string[] = []): Promise<JiraSearchResult> {
    return this.client.searchJql(jql, maxResults, undefined, extraFields);
  }

  async getFilterById(id: string): Promise<JiraFilter> {
    return this.client.getFilterById(id);
  }

  async searchFiltersByName(name: string): Promise<JiraFilter[]> {
    return this.client.searchFiltersByName(name);
  }

  /** `knownFields`, when the caller already fetched `getFieldMeta()` for another reason, avoids
   * an extra `GET /field` round-trip for a non-aliased field name. Omit it to fetch fresh. */
  async resolveFieldId(name: string, knownFields?: JiraFieldMeta[]): Promise<string> {
    // Check built-in aliases first (e.g. "fixversion", "fix version" → "fixVersions")
    const mapped = SUPPORTED_FIELDS[name.toLowerCase()];
    if (mapped) return mapped;
    // Match by display name or by field ID (handles camelCase API names like "fixVersions")
    const fields = knownFields ?? await this.client.getFields();
    const match = fields.find(f =>
      f.name.toLowerCase() === name.toLowerCase() ||
      f.id.toLowerCase() === name.toLowerCase(),
    );
    if (!match) throw new Error(`Unknown field "${name}" — check the field name in your Jira instance.`);
    return match.id;
  }

  async buildFieldValue(fieldId: string, sampleKey: string, rawValue: string): Promise<unknown> {
    const editMeta = await this.client.getEditMeta(sampleKey);
    const field = editMeta[fieldId];
    if (!field) throw new Error(`Field "${fieldId}" is not editable on ${sampleKey}.`);

    const { schema, allowedValues = [] } = field;

    if (schema.type === 'string' || schema.type === 'number') {
      return schema.type === 'number' ? parseFloat(rawValue) : rawValue;
    }

    if (schema.type === 'array') {
      if (allowedValues.length > 0 && 'value' in allowedValues[0]) {
        return [{ value: rawValue }];
      }
      return [{ name: rawValue }];
    }

    // priority, issuetype, version, component, and other named-object fields
    return { name: rawValue };
  }

  async buildArrayValue(
    fieldId: string,
    sampleKey: string,
    rawValues: string[],
    op: 'set' | 'add' | 'remove',
    currentValue: unknown,
  ): Promise<unknown> {
    const editMeta = await this.client.getEditMeta(sampleKey);
    const field = editMeta[fieldId];
    if (!field) throw new Error(`Field "${fieldId}" is not editable on ${sampleKey}.`);
    const { allowedValues = [] } = field;
    const useValueKey = allowedValues.length > 0 && 'value' in allowedValues[0];

    const wrap = (v: string) => useValueKey ? { value: v } : { name: v };
    const newItems = rawValues.map(v => wrap(v.trim()));

    if (op === 'set') return newItems;

    const existing: unknown[] = Array.isArray(currentValue) ? currentValue : [];

    if (op === 'add') {
      const combined = [...existing];
      for (const item of newItems) {
        const key = useValueKey ? (item as { value: string }).value : (item as { name: string }).name;
        const already = existing.some(e => {
          const ek = useValueKey
            ? (e as { value?: string }).value
            : (e as { name?: string }).name;
          return ek?.toLowerCase() === key.toLowerCase();
        });
        if (!already) combined.push(item);
      }
      return combined;
    }

    // remove
    return existing.filter(e => {
      const ek = useValueKey
        ? (e as { value?: string }).value ?? ''
        : (e as { name?: string }).name ?? '';
      return !rawValues.some(v => v.trim().toLowerCase() === ek.toLowerCase());
    });
  }

  async bulkUpdateField(
    ticketKeys: string[],
    fieldId: string,
    fieldValue: unknown,
    onProgress: (key: string, ok: boolean, err?: string) => void,
  ): Promise<void> {
    for (const key of ticketKeys) {
      try {
        await this.client.updateIssue(key, { [fieldId]: fieldValue });
        onProgress(key, true);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.onDiag?.('warn', `Bulk field update failed — ${key} (${fieldId})`, { issueKey: key, fieldId, error: message });
        onProgress(key, false, message);
      }
    }
  }

  async findSprints(projectKey: string, query: string): Promise<JiraSprintCandidate[]> {
    return this.client.findSprints(projectKey, query);
  }

  async getRawField(issueKey: string, fieldId: string): Promise<unknown> {
    const issue = await this.client.getIssue(issueKey);
    return (issue.fields as Record<string, unknown>)[fieldId];
  }

  async showFields(issueKey: string, fieldMeta?: JiraFieldMeta[]): Promise<string> {
    const issue = await this.client.getIssue(issueKey);
    const meta = fieldMeta ?? await this.client.getFields();
    const navigable = meta.filter(f => f.navigable === true).sort((a, b) => a.name.localeCompare(b.name));
    const rows: string[] = [];
    for (const f of navigable) {
      const value = issue.fields[f.id];
      let display: string;
      if (value === null || value === undefined || (Array.isArray(value) && value.length === 0)) {
        display = '_Not set_';
      } else if (f.schema.custom?.includes('gh-sprint') && Array.isArray(value)) {
        const sprints = value.map(parseSprintItem).filter(Boolean) as Array<{ name: string; state: string }>;
        const active = pickActiveOrFirst(sprints);
        display = active ? active.name : '_None_';
      } else if (typeof value === 'object' && value !== null && 'type' in value) {
        // ADF or rich content — truncate to 80 chars
        const text = formatJiraBody(value).replace(/\s+/g, ' ').trim();
        display = text.length > 80 ? `${text.slice(0, 80)}…` : text;
      } else if (typeof value === 'string' && value.length > 80) {
        display = `${value.slice(0, 80)}…`;
      } else {
        display = renderFieldValue(value, f);
      }
      rows.push(`| ${f.name} | \`${f.id}\` | ${display} |`);
    }
    if (rows.length === 0) return `No navigable fields found for ${issueKey}.`;
    return [
      `## Fields on ${issueKey}`,
      '',
      '| Field name | Field ID | Current value |',
      '| --- | --- | --- |',
      ...rows,
    ].join('\n');
  }

  /**
   * Template generation, reference-ticket path. Fetches `issueKey`'s fields and
   * proposes only the template-shaped ones (the fixed allowlist) as review-list candidates, each
   * carrying a literal value snapshot — never `resolveFields`. A field already in the
   * caller's `hiddenIds` (the user's configured `hiddenDisplayFields`, resolved by the
   * vscode-coupled caller — TicketService itself reads no config) is excluded before the
   * candidate list is built. A template-shaped field that's unset on the reference ticket is
   * excluded too — there's nothing to snapshot. A sprint field's raw value is parsed down to a
   * writable `{ id }` (the exception to taking the raw value as a literal snapshot); if it can't
   * be parsed, the field is dropped rather than written with a guessed value.
   */
  async getTemplateCandidatesFromTicket(
    issueKey: string,
    fieldMeta?: JiraFieldMeta[],
    hiddenIds?: Set<string>,
  ): Promise<TemplateFieldCandidate[]> {
    const issue = await this.client.getIssue(issueKey);
    const meta = fieldMeta ?? await this.client.getFields();
    const metaById = new Map(meta.map(m => [m.id, m]));
    const hidden = hiddenIds ?? new Set<string>();
    const candidates: TemplateFieldCandidate[] = [];

    for (const [fieldId, rawValue] of Object.entries(issue.fields)) {
      if (hidden.has(fieldId)) continue;
      const fm = metaById.get(fieldId);
      if (!fm || !isTemplateShapedField(fm)) continue;

      const isEmpty = rawValue === null || rawValue === undefined ||
        (Array.isArray(rawValue) && rawValue.length === 0);
      if (isEmpty) continue;

      if (fm.schema.custom?.includes('gh-sprint')) {
        const id = extractSprintIdCandidate(rawValue);
        if (id === null) continue; // unparseable — never write an unverified value
        candidates.push({ id: fieldId, name: fm.name, value: { id }, schema: fm.schema });
        continue;
      }

      candidates.push({ id: fieldId, name: fm.name, value: rawValue, schema: fm.schema });
    }

    return candidates;
  }

  /**
   * Template generation, no-reference path. `issueType` is an already-resolved input —
   * this method never prompts or guesses one itself (that belongs to the vscode-coupled chat
   * handler). Candidates come from Jira's own required-fields create-metadata, each with no
   * value; the review step fills values in later.
   */
  async getTemplateCandidatesFromRequiredFields(
    projectKey: string,
    issueType: string,
    issueTypeId?: string,
  ): Promise<TemplateFieldCandidate[]> {
    const required = await this.client.getRequiredFields(projectKey, issueType, issueTypeId);
    return required.map(f => ({ id: f.id, name: f.name, schema: f.schema }));
  }

  async createTicket(
    projectKey: string,
    summary: string,
    issueType: string,
    additionalFields?: Record<string, unknown>,
    baseUrl?: string,
  ): Promise<CreatedTicket> {
    const created = await this.client.createIssue(projectKey, summary, issueType, additionalFields);
    this.onDiag?.('info', `Ticket created — ${created.key}`, { projectKey, issueType });
    return {
      key: created.key,
      message: `Created ${formatKeyLink(created.key, baseUrl)}: **${summary}** (${issueType} in ${projectKey})`,
    };
  }
}
