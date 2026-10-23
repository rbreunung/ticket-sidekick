import { describe, it, expect, vi, beforeEach } from 'vitest';

const config: Record<string, unknown> = {};
vi.mock('vscode', () => {
  class Uri {
    constructor(public fsPath = '') {}
    static file(p: string): Uri { return new Uri(p); }
    static joinPath(base: Uri, ...parts: string[]): Uri { return new Uri([base.fsPath, ...parts].join('/')); }
  }
  return {
    Uri,
    MarkdownString: class { constructor(public value = '') {} isTrusted?: unknown; },
    workspace: {
      workspaceFolders: [{ uri: new Uri('/workspace') }],
      getConfiguration: () => ({ get: (key: string) => config[key] }),
      fs: { writeFile: vi.fn() },
    },
    window: {
      showSaveDialog: vi.fn(),
      showInputBox: vi.fn(),
      createOutputChannel: vi.fn(() => ({ appendLine: vi.fn() })),
    },
  };
});

import * as vscode from 'vscode';
import { handleSecurityOverview } from '../participant/jira/overviewHandler';
import { TicketService } from '../services/TicketService';
import { MockJiraClient } from './mocks/MockJiraClient';
import { makeComponent, makeFlaw, veracodeTicket, waltzTicket } from './helpers/overviewFixtures';
import { JiraApiError } from '../utils/apiError';

const markdownText = (arg: unknown): string => (typeof arg === 'string' ? arg : (arg as { value: string }).value);
const streamOf = () => ({ markdown: vi.fn() });
const textOf = (stream: ReturnType<typeof streamOf>) => stream.markdown.mock.calls.map(c => markdownText(c[0])).join('\n');
const request = (prompt: string) => ({ prompt }) as vscode.ChatRequest;

let client: MockJiraClient;
let service: TicketService;

function seed(tickets: ReturnType<typeof veracodeTicket>[]) {
  vi.spyOn(client, 'searchJql').mockResolvedValue({
    issues: tickets.map(t => ({
      id: t.ticket.key, key: t.ticket.key,
      fields: { summary: t.ticket.summary, status: { name: t.ticket.status }, labels: t.ticket.labels, fixVersions: t.ticket.fixVersions.map(name => ({ name })), duedate: t.ticket.dueDate },
    })) as never,
    total: tickets.length, isLast: true,
  });
  vi.spyOn(client, 'getIssue').mockImplementation(async key => ({
    id: key, key, fields: { description: tickets.find(t => t.ticket.key === key)!.description },
  }) as never);
  vi.spyOn(client, 'getProject').mockResolvedValue({
    id: '1', key: 'SEC', name: 'Security', issueTypes: [],
    versions: [{ id: '1', name: '2026.11', releaseDate: '2026-11-15' }],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(config)) delete config[key];
  client = new MockJiraClient();
  service = new TicketService(client);
});

describe('@jira /overview', () => {
  it('streams the tables for the named project with a trusted Save as CSV link', async () => {
    seed([
      veracodeTicket('SEC-1', [makeFlaw('1')], { fixVersions: ['2026.11'], dueDate: '2026-11-01' }),
      waltzTicket('SEC-2', [makeComponent('netty-codec:4.1.100')], { fixVersions: ['2026.11'] }),
    ]);
    const stream = streamOf();

    await handleSecurityOverview(request('SEC'), stream as never, service, 'https://jira.example.com');

    const text = textOf(stream);
    expect(text).toContain('Security overview — 2 unresolved tickets (Veracode 1, Waltz 1)');
    expect(text).toContain('2026.11 (releases 2026-11-15)');
    expect(text).toContain('⚠ due before release');
    expect(text).toContain('Save as CSV');
    const withLink = stream.markdown.mock.calls.map(c => c[0]).find(a => markdownText(a).includes('command:workbench.action.chat.open')) as { isTrusted?: { enabledCommands: string[] } };
    expect(withLink.isTrusted).toEqual({ enabledCommands: ['workbench.action.chat.open'] });
    expect(decodeURIComponent(text)).toContain('@jira /overview SEC csv');
  });

  it('uses the default project when the prompt names none, and asks when there is none', async () => {
    config['jira.defaultProject'] = 'SEC';
    seed([veracodeTicket('SEC-1', [makeFlaw('1')], { fixVersions: ['2026.11'] })]);
    const first = streamOf();
    await handleSecurityOverview(request(''), first as never, service);
    expect(textOf(first)).toContain('Security overview');

    config['jira.defaultProject'] = '';
    vi.mocked(vscode.window.showInputBox).mockResolvedValue(undefined);
    const second = streamOf();
    await handleSecurityOverview(request(''), second as never, service);
    expect(textOf(second)).toContain('Please name a project');
  });

  it('says so when the project has no Veracode or Waltz tickets, and offers no CSV', async () => {
    seed([]);
    const stream = streamOf();

    await handleSecurityOverview(request('SEC'), stream as never, service);

    expect(textOf(stream)).toContain('No unresolved Veracode or Waltz tickets');
    expect(textOf(stream)).not.toContain('Save as CSV');
  });

  it('shows the error and builds no tables when the search fails', async () => {
    vi.spyOn(client, 'searchJql').mockRejectedValue(new JiraApiError('Jira API error 403', 403, 'https://jira.example.com/rest/api/2/search'));
    const stream = streamOf();

    await handleSecurityOverview(request('SEC'), stream as never, service);

    expect(textOf(stream)).toContain('Could not search SEC');
    expect(textOf(stream)).not.toContain('Security overview');
  });

  it('keeps the tables and says how many tickets could not be read when some descriptions fail', async () => {
    const tickets = Array.from({ length: 6 }, (_, i) => veracodeTicket(`SEC-${i + 1}`, [makeFlaw(String(i + 1), { line: i + 1 })], { fixVersions: ['2026.11'] }));
    seed(tickets);
    vi.spyOn(client, 'getIssue').mockImplementation(async key => {
      if (['SEC-2', 'SEC-3', 'SEC-4'].includes(key)) throw new Error('forbidden');
      return { id: key, key, fields: { description: tickets.find(t => t.ticket.key === key)!.description } } as never;
    });
    const stream = streamOf();

    await handleSecurityOverview(request('SEC'), stream as never, service);

    expect(textOf(stream)).toContain('3 tickets could not be read in full');
    expect(textOf(stream)).toContain('SEC-1');
  });

  it('AE12: flags a Veracode ticket whose Due Date is already past as overdue', async () => {
    seed([veracodeTicket('SEC-1', [makeFlaw('1')], { fixVersions: ['2026.11'], dueDate: '2020-01-29' })]);
    const stream = streamOf();

    await handleSecurityOverview(request('SEC'), stream as never, service, 'https://jira.example.com');

    const text = textOf(stream);
    expect(text).toContain('2020-01-29');
    expect(text).toContain('⚠ overdue');
  });

  it('warns and flags only overdue when the project versions cannot be read', async () => {
    seed([veracodeTicket('SEC-1', [makeFlaw('1')], { fixVersions: ['2026.11'], dueDate: '2026-11-01' })]);
    vi.spyOn(client, 'getProject').mockRejectedValue(new Error('boom'));
    const stream = streamOf();

    await handleSecurityOverview(request('SEC'), stream as never, service);

    expect(textOf(stream)).toContain('could not read the release dates');
    expect(textOf(stream)).not.toContain('due before release');
  });
});

describe('@jira /overview … csv', () => {
  it('writes the CSV to the file the user picked and reports the path', async () => {
    seed([veracodeTicket('SEC-1', [makeFlaw('1')], { fixVersions: ['2026.11'] })]);
    const target = vscode.Uri.file('/workspace/out.csv');
    vi.mocked(vscode.window.showSaveDialog).mockResolvedValue(target);
    const stream = streamOf();

    await handleSecurityOverview(request('SEC csv'), stream as never, service);

    expect(vscode.window.showSaveDialog).toHaveBeenCalledTimes(1);
    const [uri, bytes] = vi.mocked(vscode.workspace.fs.writeFile).mock.calls[0];
    expect(uri).toBe(target);
    const csv = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes as Uint8Array);
    expect(csv.startsWith('﻿Source,Ticket,')).toBe(true);
    expect(csv).toContain('SEC-1');
    expect(textOf(stream)).toContain('Saved the overview to `/workspace/out.csv`');
  });

  it('uses the semicolon separator when that setting is chosen', async () => {
    config['jira.overviewCsvDelimiter'] = 'semicolon';
    seed([veracodeTicket('SEC-1', [makeFlaw('1')], { fixVersions: ['2026.11'] })]);
    vi.mocked(vscode.window.showSaveDialog).mockResolvedValue(vscode.Uri.file('/workspace/out.csv'));

    await handleSecurityOverview(request('SEC csv'), streamOf() as never, service);

    const csv = new TextDecoder().decode(vi.mocked(vscode.workspace.fs.writeFile).mock.calls[0][1] as Uint8Array);
    expect(csv.split('\r\n')[0]).toContain('Source;Ticket;Status;');
  });

  it('writes nothing and says so when the dialog is cancelled', async () => {
    seed([veracodeTicket('SEC-1', [makeFlaw('1')], { fixVersions: ['2026.11'] })]);
    vi.mocked(vscode.window.showSaveDialog).mockResolvedValue(undefined);
    const stream = streamOf();

    await handleSecurityOverview(request('SEC csv'), stream as never, service);

    expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled();
    expect(textOf(stream)).toContain('Save cancelled');
  });

  it('reports a failed write instead of claiming the file was saved', async () => {
    seed([veracodeTicket('SEC-1', [makeFlaw('1')], { fixVersions: ['2026.11'] })]);
    vi.mocked(vscode.window.showSaveDialog).mockResolvedValue(vscode.Uri.file('/readonly/out.csv'));
    vi.mocked(vscode.workspace.fs.writeFile).mockRejectedValue(new Error('EACCES'));
    const stream = streamOf();

    await handleSecurityOverview(request('SEC csv'), stream as never, service);

    expect(textOf(stream)).toContain('Could not save the file: EACCES');
    expect(textOf(stream)).not.toContain('Saved the overview');
  });

  it('does not open a save dialog for a project with nothing to save', async () => {
    seed([]);
    const stream = streamOf();

    await handleSecurityOverview(request('SEC csv'), stream as never, service);

    expect(vscode.window.showSaveDialog).not.toHaveBeenCalled();
    expect(textOf(stream)).toContain('No unresolved Veracode or Waltz tickets');
  });
});
