// Shared fixtures for the report-import handler tests: the generic test descriptor, a tiny mock
// workspaceState, a stateful fake Jira and stream-text helpers.
// Each test file still declares its own `vi.mock(...)` calls — they are hoisted per file.
import { vi } from 'vitest';
import * as vscode from 'vscode';
import { type ReportImportDescriptor, type ReportImportRow } from '../../participant/jira/reportImportHandler';
import { type ImportTemplateSelectionSession } from '../../participant/sessionState';
import { MockJiraClient } from '../mocks/MockJiraClient';
import { TicketService } from '../../services/TicketService';
import type { JiraIssue } from '../../jira/IJiraClient';

export interface TestItem {
  ref: string;
  findings?: string[];
}

export interface TestRow extends ReportImportRow {
  ref: string;
  findings: string[];
}

export const descriptor: ReportImportDescriptor<TestItem, TestRow> = {
  descriptorKind: 'veracode', // arbitrary — this generic test descriptor isn't a real importer
  scope: 'jira.testImport',
  importLabel: 'Test',
  itemNoun: 'item(s)',
  filterKindLabel: 'test',
  noMatchMessage: '_No items matched your filters._',
  fileFilter: { label: 'Test', extensions: ['test'] },
  filePickerTitle: 'Select test file',
  parseAndFilter: async () => [],
  sessionKeys: {
    templateSelection: 'jira.session.testTemplateSelection',
    review: 'jira.session.testReview',
  },
  searchLabelOf: item => [`test-${item.ref}`],
  dedupKeyOf: item => [item.ref],
  labelToDedupKey: label => (label.startsWith('test-') ? label.slice(5) : null),
  buildRowFields: item => ({ ref: item.ref, findings: item.findings ?? [], labels: [], summary: `Summary ${item.ref}`, descriptionWiki: 'desc' }),
  reviewColumns: [],
  itemRefFor: row => row.ref,
  buildTicketFields: (row, additionalFields) => ({
    summary: row.summary,
    fields: { ...additionalFields, labels: row.labels, description: row.descriptionWiki },
  }),
};

export const mockStream = () => ({ markdown: vi.fn() });

// U5: several responses now stream a trusted vscode.MarkdownString (command links) rather than a
// bare string — this file's mocked MarkdownString stores the raw text on `.value`.
export function markdownText(arg: unknown): string {
  return typeof arg === 'string' ? arg : (arg as { value: string }).value;
}

export function makeMockWs(initial: Record<string, unknown> = {}): { get: <T>(k: string, d?: T) => T | undefined; update: (k: string, v: unknown) => Promise<void>; store: Record<string, unknown> } {
  const store: Record<string, unknown> = { ...initial };
  return {
    store,
    get: <T>(key: string, defaultValue?: T) => (key in store ? store[key] as T : defaultValue),
    update: async (key: string, value: unknown) => { store[key] = value; },
  };
}

export function makeSession(overrides: Partial<ImportTemplateSelectionSession<TestItem>> = {}): ImportTemplateSelectionSession<TestItem> {
  return {
    reportFileName: 'report.test',
    projectKey: 'PROJ',
    items: [{ ref: '1' }],
    availableTemplates: [],
    availableIssueTypes: ['Bug', 'Story'],
    schemaVersion: 1,
    ...overrides,
  };
}

export interface FakeTicket { labels: string[]; summary?: string; description?: string; resolution?: { name: string } | null; created?: string; status?: string }

/** A small stateful Jira: getIssue/updateIssue/createIssue share one ticket store. */
export function statefulJira(client: MockJiraClient, tickets: Record<string, FakeTicket>) {
  client.getIssue = async (key: string) => ({
    id: '1', key, fields: {
      labels: tickets[key]?.labels ?? [], summary: tickets[key]?.summary ?? `Summary of ${key}`,
      status: { name: tickets[key]?.status ?? 'Open' }, resolution: tickets[key]?.resolution ?? null,
    } as JiraIssue['fields'],
  });
  client.updateIssue = async (key: string, fields: Record<string, unknown>) => {
    client.updateIssueCalls.push({ issueKey: key, fields });
    if (Array.isArray(fields.labels)) tickets[key].labels = fields.labels as string[];
    if (typeof fields.summary === 'string') tickets[key].summary = fields.summary;
    if (typeof fields.description === 'string') tickets[key].description = fields.description;
  };
  let next = 100;
  client.createIssue = async (projectKey: string, summary: string, issueType: string, additionalFields?: Record<string, unknown>) => {
    client.createIssueCalls.push({ projectKey, summary, issueType, additionalFields });
    const key = `PROJ-${next++}`;
    tickets[key] = { labels: (additionalFields?.labels as string[]) ?? [], summary, resolution: null, status: 'Open' };
    return { id: key, key };
  };
}

/** Answers the dedup search from the same ticket store, so a rebuilt session sees earlier writes. */
export function searchFromStore(ticketService: TicketService, tickets: Record<string, FakeTicket>) {
  return vi.spyOn(ticketService, 'searchTicketsRaw').mockImplementation(async (jql: string) => {
    if (!jql.includes('labels in (')) return { issues: [], total: 0, isLast: true } as never;
    const issues = Object.entries(tickets)
      .filter(([, t]) => t.labels.some(l => jql.includes(`"${l}"`)))
      .map(([key, t]) => ({
        key,
        fields: {
          labels: t.labels, resolution: t.resolution ?? null, created: t.created ?? '2026-01-01T09:00:00.000+0000',
          status: { name: t.status ?? 'Open' },
        },
      }));
    return { issues, total: issues.length, isLast: true } as never;
  });
}

export function streamText(stream: ReturnType<typeof mockStream>): string {
  return (stream.markdown as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => markdownText(c[0])).join('\n');
}

export function diagLines(): string[] {
  return vi.mocked(vscode.window.createOutputChannel).mock.results
    .flatMap(r => (r.value as { appendLine: ReturnType<typeof vi.fn> }).appendLine.mock.calls.map(c => String(c[0])));
}

// A generic descriptor with change tracking: findings are recorded as `test-f-<id>` labels.
export const trackedDescriptor: ReportImportDescriptor<TestItem, TestRow> = {
  ...descriptor,
  changeTracking: {
    findingNoun: 'finding(s)',
    describe: (item, known) => {
      const knownIds = known.filter(l => l.startsWith('test-f-')).map(l => l.slice('test-f-'.length));
      if (knownIds.length === 0) return { kind: 'baseline' };
      const newIds = (item.findings ?? []).filter(f => !knownIds.includes(f));
      return newIds.length > 0 ? { kind: 'findings', newIds } : null;
    },
    recordLabelsOf: (row, change) => (change.kind === 'baseline' ? row.findings : change.newIds).map(f => `test-f-${f}`),
    buildUpdateComment: (_row, change) => `New findings: ${change.newIds.join(', ')}`,
    buildFollowUp: (row, change, originalKey, additionalFields) => ({
      summary: `${row.summary} (follow-up to ${originalKey})`,
      fields: { ...additionalFields, labels: [`test-${row.ref}`, ...change.newIds.map(f => `test-f-${f}`)], description: 'follow-up' },
    }),
  },
};
