import type { IJiraClient, JiraComment, JiraEditMetaField, JiraFieldMeta, JiraFilter, JiraIssue, JiraIssueType, JiraSearchResult, JiraSprintCandidate } from '../jira/IJiraClient';
import { formatJiraBody } from '../utils/markdownFormatter';

export type FieldResolutionResult =
  | { kind: 'match'; field: JiraFieldMeta }
  | { kind: 'candidates'; fields: JiraFieldMeta[] }
  | { kind: 'none' };

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

const EXCLUDED_FROM_TABLE = new Set(['summary', 'comment', 'subtasks']);

function renderSingleFieldValue(value: unknown, meta: JiraFieldMeta): string {
  if (value === null || value === undefined) return '_Not set_';

  // Sprint (gh-sprint in custom)
  if (meta.schema.custom?.includes('gh-sprint') && Array.isArray(value)) {
    const sprints = value as Array<{ name: string; state: string }>;
    const active = sprints.find(s => s.state === 'active') ?? sprints[0];
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

function isMultiLine(value: unknown, meta: JiraFieldMeta): boolean {
  if (typeof value === 'object' && value !== null && !Array.isArray(value) && 'type' in value) return true;
  if (typeof value === 'string' && value.length > 120) return true;
  // Attachment list handled separately; all other cases single-line
  return false;
}

export function formatIssueFields(
  issue: JiraIssue,
  fieldMeta: JiraFieldMeta[],
  alwaysShowIds: Set<string>,
  hiddenIds?: Set<string>,
): { table: string; sections: string[] } {
  const navigable = new Map(fieldMeta.filter(f => f.navigable === true).map(f => [f.id, f]));
  const tableRows: string[] = [];
  const sections: string[] = [];
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
      const links = (value as Array<{ filename: string; content: string }>)
        .map(a => `[${a.filename}](${a.content})`).join(', ');
      sections.push(`## Attachments\n\n${links}`);
      continue;
    }

    if (isMultiLine(value, meta)) {
      const content = formatJiraBody(value).trim() || '_No content_';
      sections.push(`## ${meta.name}\n\n${content}`);
    } else {
      tableRows.push(`| **${meta.name}** | ${renderSingleFieldValue(value, meta)} |`);
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
  constructor(private readonly client: IJiraClient) {}

  async getFieldMeta(): Promise<JiraFieldMeta[]> {
    return this.client.getFields();
  }

  async getTicket(
    issueKey: string,
    fieldMeta?: JiraFieldMeta[],
    alwaysShowIds?: Set<string>,
    hiddenIds?: Set<string>,
  ): Promise<string> {
    const issue = await this.client.getIssue(issueKey);
    const meta = fieldMeta ?? await this.client.getFields();
    const showIds = alwaysShowIds ?? new Set<string>();
    const { table, sections } = formatIssueFields(issue, meta, showIds, hiddenIds);
    const parts: string[] = [`## ${issue.key}: ${issue.fields.summary}`];
    if (table) parts.push('', table);
    if (sections.length > 0) parts.push('', ...sections.map(s => s));
    return parts.join('\n');
  }

  async addComment(issueKey: string, body: string): Promise<string> {
    await this.client.addComment(issueKey, body);
    return `comment added to ${issueKey}.`;
  }

  async updateField(issueKey: string, fieldName: string, value: string): Promise<string> {
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
    return `Updated ${fieldName} on ${issueKey}.`;
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

  async searchTickets(jql: string): Promise<string> {
    const result = await this.client.searchJql(jql);
    if (result.issues.length === 0) return 'No tickets found.';
    const rows = result.issues.map((issue) => {
      const assignee = issue.fields.assignee ? issue.fields.assignee.displayName : 'Unassigned';
      return `| ${issue.key} | ${issue.fields.summary} | ${issue.fields.status.name} | ${assignee} |`;
    });
    return [
      `Found ${result.total ?? result.issues.length} ticket(s):`,
      '',
      '| Key | Summary | Status | Assignee |',
      '| --- | --- | --- | --- |',
      ...rows,
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
    for (const step of path) {
      const fields: Record<string, unknown> = {};
      if (resolution && step.to === path.at(-1)!.to) fields.resolution = { name: resolution };
      const hasFields = Object.keys(fields).length > 0;
      try {
        await this.client.executeTransition(issueKey, step.id, hasFields ? fields : undefined);
      } catch (err) {
        if (hasFields && err instanceof Error && err.message.includes('"resolution"')) {
          await this.client.executeTransition(issueKey, step.id, undefined);
        } else {
          throw err;
        }
      }
    }
  }

  async searchTicketsRaw(jql: string, maxResults = 50): Promise<JiraSearchResult> {
    return this.client.searchJql(jql, maxResults);
  }

  async getFilterById(id: string): Promise<JiraFilter> {
    return this.client.getFilterById(id);
  }

  async searchFiltersByName(name: string): Promise<JiraFilter[]> {
    return this.client.searchFiltersByName(name);
  }

  async resolveFieldId(name: string): Promise<string> {
    const fields = await this.client.getFields();
    const match = fields.find(f => f.name.toLowerCase() === name.toLowerCase());
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
        onProgress(key, false, err instanceof Error ? err.message : String(err));
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
    const navigable = meta.filter(f => f.navigable === true);
    const rows: string[] = [];
    for (const f of navigable) {
      const value = issue.fields[f.id];
      let display: string;
      if (value === null || value === undefined || (Array.isArray(value) && value.length === 0)) {
        display = '_Not set_';
      } else if (f.schema.custom?.includes('gh-sprint') && Array.isArray(value)) {
        const sprints = value as Array<{ name: string; state: string }>;
        const active = sprints.find(s => s.state === 'active') ?? sprints[0];
        display = active ? active.name : '_None_';
      } else if (typeof value === 'object' && value !== null && 'type' in value) {
        // ADF or rich content — truncate to 80 chars
        const text = formatJiraBody(value).replace(/\s+/g, ' ').trim();
        display = text.length > 80 ? `${text.slice(0, 80)}…` : text;
      } else if (typeof value === 'string' && value.length > 80) {
        display = `${value.slice(0, 80)}…`;
      } else {
        display = renderSingleFieldValue(value, f);
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

  async createTicket(
    projectKey: string,
    summary: string,
    issueType: string,
    additionalFields?: Record<string, unknown>,
  ): Promise<string> {
    const created = await this.client.createIssue(projectKey, summary, issueType, additionalFields);
    return `Created ${created.key}: **${summary}** (${issueType} in ${projectKey})`;
  }
}
