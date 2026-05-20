import type { IJiraClient, JiraComment, JiraEditMetaField, JiraFieldMeta, JiraFilter, JiraIssue, JiraIssueType, JiraSearchResult } from '../jira/IJiraClient';
import { formatJiraBody } from '../utils/markdownFormatter';

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

function formatIssue(issue: JiraIssue): string {
  const f = issue.fields;
  const description = f.description
    ? formatJiraBody(f.description).trim() || '_No description_'
    : '_No description_';
  const assignee = f.assignee ? f.assignee.displayName : '_Unassigned_';
  const priority = f.priority ? f.priority.name : '_None_';
  const labels = f.labels.length > 0 ? f.labels.join(', ') : '_None_';
  const fixVersions = f.fixVersions.length > 0
    ? f.fixVersions.map((v) => v.name).join(', ')
    : '_None_';
  return [
    `## ${issue.key}: ${f.summary}`,
    `**Status:** ${f.status.name}`,
    `**Assignee:** ${assignee}`,
    `**Reporter:** ${f.reporter ? f.reporter.displayName : '_Unknown_'}`,
    `**Priority:** ${priority}`,
    `**Labels:** ${labels}`,
    `**Fix Versions:** ${fixVersions}`,
    '',
    '**Description:**',
    description,
  ].join('\n');
}

export class TicketService {
  constructor(private readonly client: IJiraClient) {}

  async getTicket(issueKey: string): Promise<string> {
    const issue = await this.client.getIssue(issueKey);
    return formatIssue(issue);
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
