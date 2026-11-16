import * as fs from 'fs';
import * as path from 'path';
import { importJiraDeps } from '../../boards/import/jiraDeps';
import type { ImportDeps } from '../../boards/import/read';
import { createVeracodeDescriptor } from '../../imports/veracode';
import { createWaltzDescriptor } from '../../imports/waltz';
import { createEmailDescriptor } from '../../imports/email';
import type { JiraCreatedIssue, JiraIssue, JiraSearchResult } from '../../jira/IJiraClient';
import { MockJiraClient } from '../mocks/MockJiraClient';

// A Veracode import against a Jira that starts with no tickets: the board's dedup and stale
// searches find nothing, and every create is kept, so a later read sees it.

export class EmptyProjectJira extends MockJiraClient {
  tickets: Record<string, { labels: string[]; summary: string }> = {};
  private nextKey = 100;

  /** Makes the subject search of an email import fail. */
  summarySearchFails = false;

  override async searchJql(jql: string): Promise<JiraSearchResult> {
    if (jql.includes('summary ~') && this.summarySearchFails) throw new Error('Jira is down');
    // Every ticket is a candidate of a subject search; the board compares the summaries itself.
    const keys = jql.startsWith('key in (') || jql.includes('summary ~') ? Object.keys(this.tickets) : [];
    const issues = keys.map(key => ({
      id: key, key,
      fields: {
        labels: this.tickets[key].labels, summary: this.tickets[key].summary, status: { name: 'Open' }, resolution: null,
        updated: 'u1', issuetype: { name: 'Bug' }, fixVersions: [], description: '',
      },
    })) as unknown as JiraIssue[];
    return { issues, total: issues.length, isLast: true };
  }

  override async getProject(): Promise<never> {
    return { key: 'PROJ', name: 'Project', issueTypes: [{ name: 'Bug', subtask: false }], versions: [] } as never;
  }

  override async createIssue(projectKey: string, summary: string, issueType: string, additionalFields?: Record<string, unknown>): Promise<JiraCreatedIssue> {
    this.createIssueCalls.push({ projectKey, summary, issueType, additionalFields });
    const key = `${projectKey}-${this.nextKey++}`;
    this.tickets[key] = { labels: (additionalFields?.labels as string[]) ?? [], summary };
    return { id: key, key, self: '' } as JiraCreatedIssue;
  }
}

/** The import board's dependencies for a workspace in `dir` with the template "Security bug" (issue type Bug). */
export function emptyProjectImportDeps(dir: string, jira: MockJiraClient, emailOptions: { deleteEmlAfterImport?: boolean } = {}): ImportDeps {
  fs.writeFileSync(path.join(dir, '.jira-templates.json'), JSON.stringify({ templates: [{ name: 'Security bug', issueType: 'Bug', defaultFields: { labels: ['security'] } }] }));
  const veracode = createVeracodeDescriptor({
    filter: () => ({ minSeverity: 3, includeStatuses: ['New', 'Open', 'Reopened'], maxReportBytes: 20 * 1024 * 1024 }),
    slaDays: () => ({ High: 30 }),
  }, { reviewColumns: [] });
  const waltz = createWaltzDescriptor({
    filter: () => ({ minVulnRating: 'High', includeRemediationActions: ['', 'Remediate'], maxReportBytes: 20 * 1024 * 1024 }),
    minVulnRating: () => 'High',
    workspaceRoot: () => dir,
  }, { reviewColumns: [] });
  return importJiraDeps({
    getJira: async () => ({ configured: true, client: jira, config: { baseUrl: 'https://jira.example.com' } }) as never,
    workspaceFolder: () => dir,
    descriptors: {
      veracode, waltz,
      email: createEmailDescriptor({ deleteEmlAfterImport: () => emailOptions.deleteEmlAfterImport ?? false, maxBatchBytes: () => 150 * 1024 * 1024 }),
    },
    now: () => Date.parse('2026-11-15T12:00:00Z'),
  });
}

const xmlAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A Veracode Detailed Report with one High finding per source file, issue ids from 101. */
export function veracodeReport(files: string[]): string {
  const flaws = files.map((file, n) => `
          <flaw severity="4" categoryname="Credentials Management" count="1" issueid="${101 + n}" module="App.war"
                type="Hard-coded Password" description="A hard-coded password."
                cweid="798" remediationeffort="2" exploitLevel="3" categoryid="18"
                date_first_occurrence="2026-04-20T14:00:00.000-0000" remediation_status="New"
                sourcefile="${xmlAttr(file)}" line="${10 + n}" sourcefilepath="com/example/" mitigation_status="none"/>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<detailedreport xmlns="https://analysiscenter.veracode.com/schema/2.0/detailedreport" report_format_version="1.5" app_name="App">
  <severity level="4">
    <category categoryid="18" categoryname="Credentials Management" pcirelated="true">
      <desc><para text="Hard-coded credentials."/></desc>
      <recommendations><para text="Use a secrets manager."/></recommendations>
      <cwe cweid="798" cwename="Use of Hard-coded Credentials">
        <description><para text="Risky."/></description>
        <staticflaws>${flaws}
        </staticflaws>
      </cwe>
    </category>
  </severity>
</detailedreport>`;
}

/** A small `.eml` file with a subject, a text body and, when named, one attached text file. */
export function emlFile(dir: string, name: string, subject: string, options: { body?: string; attachment?: string } = {}): string {
  const file = path.join(dir, name);
  const boundary = 'BOUNDARY';
  const parts = [
    'From: Ann Example <ann@example.com>',
    'To: support@example.com',
    `Subject: ${subject}`,
    'Date: Mon, 16 Nov 2026 08:00:00 +0000',
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    options.body ?? 'The login page fails.',
  ];
  if (options.attachment) {
    parts.push(
      `--${boundary}`,
      `Content-Type: text/plain; name="${options.attachment}"`,
      `Content-Disposition: attachment; filename="${options.attachment}"`,
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from('log line').toString('base64'),
    );
  }
  parts.push(`--${boundary}--`, '');
  fs.writeFileSync(file, parts.join('\r\n'));
  return file;
}
