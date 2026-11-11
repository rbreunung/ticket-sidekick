import ExcelJS from 'exceljs';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
import { makeComponent, makeFlaw, seedOverviewJira, veracodeTicket, waltzTicket } from './helpers/overviewFixtures';
import { JiraApiError } from '../utils/apiError';

const markdownText = (arg: unknown): string => (typeof arg === 'string' ? arg : (arg as { value: string }).value);
const streamOf = () => ({ markdown: vi.fn() });
const textOf = (stream: ReturnType<typeof streamOf>) => stream.markdown.mock.calls.map(c => markdownText(c[0])).join('\n');
const request = (prompt: string) => ({ prompt }) as vscode.ChatRequest;

let client: MockJiraClient;
let service: TicketService;

const seed = (tickets: ReturnType<typeof veracodeTicket>[]) => seedOverviewJira(client, tickets);

beforeEach(() => {
  // The fixtures' due dates (2026-11-01) and release (2026-11-15) only mean "due before release" while today is before them.
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-15T12:00:00Z') });
  vi.clearAllMocks();
  for (const key of Object.keys(config)) delete config[key];
  client = new MockJiraClient();
  service = new TicketService(client);
});

afterEach(() => { vi.useRealTimers(); });

describe('@jira /security-report', () => {
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
    expect(decodeURIComponent(text)).toContain('@jira /security-report SEC csv');
    expect(text).toContain('Save as Excel');
    expect(decodeURIComponent(text)).toContain('@jira /security-report SEC xlsx');
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
    expect(textOf(second)).toContain('@jira /security-report PROJ');
  });

  it('is registered as /security-report, and /overview is no longer a slash command', () => {
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf-8')) as { contributes: { chatParticipants: Array<{ name: string; commands?: Array<{ name: string; description: string }> }> } };
    const commands = pkg.contributes.chatParticipants.find(p => p.name === 'jira')?.commands ?? [];
    const names = commands.map(c => c.name);
    expect(names).toContain('security-report');
    expect(names).not.toContain('overview');
    expect(commands.find(c => c.name === 'security-report')?.description).toMatch(/Veracode and Waltz/);
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

describe('@jira /security-report chat output, word for word', () => {
  it('streams the progress line, the truncation and release-date warnings, then the tables', async () => {
    seed([veracodeTicket('SEC-1', [makeFlaw('1')], { fixVersions: ['2026.11'], dueDate: '2026-11-01' })]);
    vi.spyOn(service, 'listOverviewTickets').mockImplementation(async () => {
      const issues = (await client.searchJql('', 1)).issues;
      return { tickets: issues.map(i => ({ key: i.key, summary: String(i.fields.summary), status: 'Open', source: 'veracode', labels: (i.fields.labels ?? []) as string[], fixVersions: ['2026.11'], dueDate: '2026-11-01' })), truncated: true } as never;
    });
    vi.spyOn(client, 'getProject').mockRejectedValue(new Error('boom'));
    const stream = streamOf();

    await handleSecurityOverview(request('SEC'), stream as never, service, 'https://jira.example.com');

    const calls = stream.markdown.mock.calls.map(c => markdownText(c[0]));
    expect(calls.slice(0, 3)).toEqual([
      '_Searching SEC for open Veracode and Waltz tickets…_\n\n',
      '_More tickets matched than can be listed; showing the first 1._\n\n',
      '_Warning: could not read the release dates, so nothing is flagged as due before its release._\n\n',
    ]);
    expect(calls).toHaveLength(4);
    expect(calls[3]).toContain('SEC-1');
  });

  it('streams the search failure with Jira\'s error message, as before', async () => {
    vi.spyOn(client, 'searchJql').mockRejectedValue(new JiraApiError('Jira API error 403', 403, 'https://jira.example.com/rest/api/2/search'));
    const stream = streamOf();

    await handleSecurityOverview(request('SEC'), stream as never, service);

    expect(stream.markdown.mock.calls.map(c => markdownText(c[0]))).toEqual([
      '_Searching SEC for open Veracode and Waltz tickets…_\n\n',
      'Could not search SEC: Jira API error 403',
    ]);
  });
});

describe('@jira /security-report … csv', () => {
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
    expect(textOf(stream)).toContain('Saved the security report to `/workspace/out.csv`');
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
    expect(textOf(stream)).not.toContain('Saved the security report');
  });

  it('does not open a save dialog for a project with nothing to save', async () => {
    seed([]);
    const stream = streamOf();

    await handleSecurityOverview(request('SEC csv'), stream as never, service);

    expect(vscode.window.showSaveDialog).not.toHaveBeenCalled();
    expect(textOf(stream)).toContain('No unresolved Veracode or Waltz tickets');
  });
});

describe('@jira /security-report … xlsx', () => {
  beforeEach(() => { vi.mocked(vscode.workspace.fs.writeFile).mockResolvedValue(undefined); });

  async function savedWorkbook(): Promise<ExcelJS.Workbook> {
    const bytes = vi.mocked(vscode.workspace.fs.writeFile).mock.calls[0][1] as Uint8Array;
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.from(bytes) as never);
    return workbook;
  }

  it('writes an Excel workbook to the file the user picked, offering .xlsx files, and reports the path', async () => {
    seed([veracodeTicket('SEC-1', [makeFlaw('1')], { fixVersions: ['2026.11'], dueDate: '2026-11-01' })]);
    const target = vscode.Uri.file('/workspace/out.xlsx');
    vi.mocked(vscode.window.showSaveDialog).mockResolvedValue(target);
    const stream = streamOf();

    await handleSecurityOverview(request('SEC xlsx'), stream as never, service);

    expect(vi.mocked(vscode.window.showSaveDialog).mock.calls[0][0]).toMatchObject({ filters: { Excel: ['xlsx'] } });
    expect(vi.mocked(vscode.window.showSaveDialog).mock.calls[0][0]?.defaultUri?.fsPath).toMatch(/security-overview-SEC-\d{4}-\d{2}-\d{2}\.xlsx$/);
    expect(vi.mocked(vscode.workspace.fs.writeFile).mock.calls[0][0]).toBe(target);
    const sheet = (await savedWorkbook()).getWorksheet('Security overview')!;
    expect(sheet.getRow(2).values).toContain('SEC-1');
    expect(textOf(stream)).toContain('Saved the security report to `/workspace/out.xlsx`');
  });

  it('ignores the CSV delimiter setting', async () => {
    config['jira.overviewCsvDelimiter'] = 'semicolon';
    seed([veracodeTicket('SEC-1', [makeFlaw('1')], { fixVersions: ['2026.11'] })]);
    vi.mocked(vscode.window.showSaveDialog).mockResolvedValue(vscode.Uri.file('/workspace/out.xlsx'));

    await handleSecurityOverview(request('SEC xlsx'), streamOf() as never, service);

    expect((await savedWorkbook()).getWorksheet('Security overview')!.getRow(1).getCell(1).value).toBe('Source');
  });

  it('writes nothing and says so when the dialog is cancelled', async () => {
    seed([veracodeTicket('SEC-1', [makeFlaw('1')], { fixVersions: ['2026.11'] })]);
    vi.mocked(vscode.window.showSaveDialog).mockResolvedValue(undefined);
    const stream = streamOf();

    await handleSecurityOverview(request('SEC xlsx'), stream as never, service);

    expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled();
    expect(textOf(stream)).toContain('Save cancelled');
  });

  it('reports a failed write instead of claiming the file was saved', async () => {
    seed([veracodeTicket('SEC-1', [makeFlaw('1')], { fixVersions: ['2026.11'] })]);
    vi.mocked(vscode.window.showSaveDialog).mockResolvedValue(vscode.Uri.file('/readonly/out.xlsx'));
    vi.mocked(vscode.workspace.fs.writeFile).mockRejectedValue(new Error('EACCES'));
    const stream = streamOf();

    await handleSecurityOverview(request('SEC xlsx'), stream as never, service);

    expect(textOf(stream)).toContain('Could not save the file: EACCES');
    expect(textOf(stream)).not.toContain('Saved the security report');
  });

  it('does not open a save dialog for a project with nothing to save', async () => {
    seed([]);
    const stream = streamOf();

    await handleSecurityOverview(request('SEC xlsx'), stream as never, service);

    expect(vscode.window.showSaveDialog).not.toHaveBeenCalled();
    expect(textOf(stream)).toContain('No unresolved Veracode or Waltz tickets');
  });
});
