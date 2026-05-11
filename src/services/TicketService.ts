import type { IJiraClient, JiraComment, JiraIssue, JiraIssueType } from '../jira/IJiraClient';

const SUPPORTED_FIELDS: Record<string, string> = {
  summary: 'summary',
  description: 'description',
  priority: 'priority',
  assignee: 'assignee',
  labels: 'labels',
  'fix version': 'fixVersions',
  fixversions: 'fixVersions',
};

function extractTextFromAdf(node: unknown): string {
  if (!node || typeof node !== 'object') return '';
  const n = node as { text?: string; content?: unknown[] };
  if (typeof n.text === 'string') return n.text;
  if (Array.isArray(n.content)) return n.content.map(extractTextFromAdf).join(' ');
  return '';
}

export function wrapInAdf(text: string): object {
  return {
    type: 'doc',
    version: 1,
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  };
}

export function assembleDescription(sections: string[], answers: Record<string, string>): string {
  return sections
    .filter((s) => s in answers)
    .map((s) => `**${s}**\n${answers[s]}`)
    .join('\n\n');
}

function formatComments(comments: JiraComment[]): string {
  if (comments.length === 0) return '';
  const lines = comments.map((c) => {
    const date = c.created.slice(0, 10);
    const body = extractTextFromAdf(c.body).trim() || '_empty_';
    return `**${c.author.displayName}** (${date})\n${body}`;
  });
  return `**Comments:**\n\n${lines.join('\n\n')}`;
}

function formatIssue(issue: JiraIssue): string {
  const f = issue.fields;
  const description = f.description
    ? extractTextFromAdf(f.description).trim() || '_No description_'
    : '_No description_';
  const assignee = f.assignee ? f.assignee.displayName : '_Unassigned_';
  const priority = f.priority ? f.priority.name : '_None_';
  const labels = f.labels.length > 0 ? f.labels.join(', ') : '_None_';
  const fixVersions = f.fixVersions.length > 0
    ? f.fixVersions.map((v) => v.name).join(', ')
    : '_None_';
  const commentSection = formatComments(f.comment?.comments ?? []);
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
    ...(commentSection ? ['', commentSection] : []),
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
        .filter((k) => !k.includes('fix'))
        .concat(['fix version'])
        .join(', ');
      return `Field "${fieldName}" is not supported. Supported fields: ${supported}.`;
    }

    let fieldValue: unknown;
    if (jiraField === 'priority') {
      fieldValue = { name: value };
    } else if (jiraField === 'assignee') {
      const ME_KEYWORDS = new Set(['me', 'myself', 'i']);
      if (ME_KEYWORDS.has(value.toLowerCase().trim())) {
        const currentUser = await this.client.getCurrentUser();
        fieldValue = { accountId: currentUser.accountId };
      } else {
        const users = await this.client.findUser(value);
        if (users.length === 0) return `No user found matching "${value}".`;
        if (users.length > 1) {
          return `Multiple users found: ${users.map((u) => u.displayName).join(', ')}. Please be more specific.`;
        }
        fieldValue = { accountId: users[0].accountId };
      }
    } else if (jiraField === 'description') {
      fieldValue = wrapInAdf(value);
    } else if (jiraField === 'labels') {
      fieldValue = value.split(',').map((l) => l.trim());
    } else if (jiraField === 'fixVersions') {
      fieldValue = [{ name: value }];
    } else {
      fieldValue = value;
    }

    await this.client.updateIssue(issueKey, { [jiraField]: fieldValue });
    return `Updated ${fieldName} on ${issueKey}.`;
  }

  async searchTickets(jql: string): Promise<string> {
    const result = await this.client.searchJql(jql);
    if (result.issues.length === 0) return 'No tickets found.';
    const rows = result.issues.map((issue) => {
      const assignee = issue.fields.assignee ? issue.fields.assignee.displayName : 'Unassigned';
      return `| ${issue.key} | ${issue.fields.summary} | ${issue.fields.status.name} | ${assignee} |`;
    });
    return [
      `Found ${result.total} ticket(s):`,
      '',
      '| Key | Summary | Status | Assignee |',
      '| --- | --- | --- | --- |',
      ...rows,
    ].join('\n');
  }

  async validateRequiredFields(issueKey: string, requiredFields: string[]): Promise<string> {
    if (requiredFields.length === 0) {
      return 'No required fields configured. Add field names to `jiraCopilot.requiredFields` in settings.';
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
